import process from 'node:process';
import path from 'node:path';
import { existsSync, watch, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import tsval from 'typescript';
import vm from 'node:vm';
import streamConsumers from 'node:stream/consumers';

class EventEmitter {
    static #handlers = new Set();
    #scopeHandlers = new Set();
    addHandler(handler) {
        this.#scopeHandlers.add(handler);
        EventEmitter.#handlers.add(handler);
    }
    static dispatch(event) {
        for (const handler of EventEmitter.#handlers) {
            handler.handleEvent(event);
        }
    }
    removeHandler(handler) {
        this.#scopeHandlers.delete(handler);
        EventEmitter.#handlers.delete(handler);
    }
    removeHandlers() {
        for (const handler of this.#scopeHandlers) {
            EventEmitter.#handlers.delete(handler);
        }
        this.#scopeHandlers.clear();
    }
}

class CancellationHandler {
    #cancellationToken;
    #cancellationReason;
    constructor(cancellationToken, cancellationReason) {
        this.#cancellationToken = cancellationToken;
        this.#cancellationReason = cancellationReason;
    }
    handleEvent([, payload]) {
        if ("diagnostics" in payload) {
            if (payload.diagnostics.some((diagnostic) => diagnostic.category === "error")) {
                this.#cancellationToken.cancel(this.#cancellationReason);
            }
        }
    }
}

class ExitCodeHandler {
    handleEvent([eventName, payload]) {
        if (eventName === "run:start") {
            this.resetCode();
            return;
        }
        if ("diagnostics" in payload) {
            if (payload.diagnostics.some((diagnostic) => diagnostic.category === "error")) {
                this.#setCode(1);
            }
        }
    }
    resetCode() {
        this.#setCode(0);
    }
    #setCode(exitCode) {
        process.exitCode = exitCode;
    }
}

class ResultTiming {
    end = Number.NaN;
    start = Number.NaN;
    get duration() {
        return this.end - this.start;
    }
}

class DescribeResult {
    describe;
    parent;
    results = [];
    timing = new ResultTiming();
    constructor(describe, parent) {
        this.describe = describe;
        this.parent = parent;
    }
}

class ExpectResult {
    assertion;
    diagnostics = [];
    parent;
    status = "runs";
    timing = new ResultTiming();
    constructor(assertion, parent) {
        this.assertion = assertion;
        this.parent = parent;
    }
}

class ProjectResult {
    compilerVersion;
    diagnostics = [];
    projectConfigFilePath;
    results = [];
    constructor(compilerVersion, projectConfigFilePath) {
        this.compilerVersion = compilerVersion;
        this.projectConfigFilePath = projectConfigFilePath;
    }
}

class ResultCount {
    failed = 0;
    passed = 0;
    skipped = 0;
    todo = 0;
    get total() {
        return this.failed + this.passed + this.skipped + this.todo;
    }
}

class Result {
    expectCount = new ResultCount();
    fileCount = new ResultCount();
    resolvedConfig;
    results = [];
    targetCount = new ResultCount();
    tasks;
    testCount = new ResultCount();
    timing = new ResultTiming();
    constructor(resolvedConfig, tasks) {
        this.resolvedConfig = resolvedConfig;
        this.tasks = tasks;
    }
}

var ResultStatus;
(function (ResultStatus) {
    ResultStatus["Runs"] = "runs";
    ResultStatus["Passed"] = "passed";
    ResultStatus["Failed"] = "failed";
    ResultStatus["Skipped"] = "skipped";
    ResultStatus["Todo"] = "todo";
})(ResultStatus || (ResultStatus = {}));

class TargetResult {
    results = new Map();
    status = "runs";
    tasks;
    timing = new ResultTiming();
    versionTag;
    constructor(versionTag, tasks) {
        this.versionTag = versionTag;
        this.tasks = tasks;
    }
}

class TaskResult {
    diagnostics = [];
    expectCount = new ResultCount();
    results = [];
    status = "runs";
    task;
    testCount = new ResultCount();
    timing = new ResultTiming();
    constructor(task) {
        this.task = task;
    }
}

class TestResult {
    diagnostics = [];
    expectCount = new ResultCount();
    parent;
    results = [];
    status = "runs";
    test;
    timing = new ResultTiming();
    constructor(test, parent) {
        this.test = test;
        this.parent = parent;
    }
}

class ResultHandler {
    #describeResult;
    #expectResult;
    #projectResult;
    #result;
    #targetResult;
    #taskResult;
    #testResult;
    handleEvent([eventName, payload]) {
        switch (eventName) {
            case "run:start":
                this.#result = payload.result;
                this.#result.timing.start = Date.now();
                break;
            case "run:end":
                this.#result.timing.end = Date.now();
                this.#result = undefined;
                break;
            case "target:start":
                this.#result.results.push(payload.result);
                this.#targetResult = payload.result;
                this.#targetResult.timing.start = Date.now();
                break;
            case "target:end":
                if (this.#targetResult.status === "failed") {
                    this.#result.targetCount.failed++;
                }
                else {
                    this.#result.targetCount.passed++;
                    this.#targetResult.status = "passed";
                }
                this.#targetResult.timing.end = Date.now();
                this.#targetResult = undefined;
                break;
            case "store:error":
                if (payload.diagnostics.some(({ category }) => category === "error")) {
                    this.#targetResult.status = "failed";
                }
                break;
            case "project:uses": {
                let projectResult = this.#targetResult.results.get(payload.projectConfigFilePath);
                if (!projectResult) {
                    projectResult = new ProjectResult(payload.compilerVersion, payload.projectConfigFilePath);
                    this.#targetResult.results.set(payload.projectConfigFilePath, projectResult);
                }
                this.#projectResult = projectResult;
                break;
            }
            case "project:error":
                this.#targetResult.status = "failed";
                this.#projectResult.diagnostics.push(...payload.diagnostics);
                break;
            case "task:start":
                this.#projectResult.results.push(payload.result);
                this.#taskResult = payload.result;
                this.#taskResult.timing.start = Date.now();
                break;
            case "task:error":
                this.#targetResult.status = "failed";
                this.#taskResult.status = "failed";
                this.#taskResult.diagnostics.push(...payload.diagnostics);
                break;
            case "task:end":
                if (this.#taskResult.status === "failed" ||
                    this.#taskResult.expectCount.failed > 0 ||
                    this.#taskResult.testCount.failed > 0) {
                    this.#result.fileCount.failed++;
                    this.#targetResult.status = "failed";
                    this.#taskResult.status = "failed";
                }
                else {
                    this.#result.fileCount.passed++;
                    this.#taskResult.status = "passed";
                }
                this.#taskResult.timing.end = Date.now();
                this.#taskResult = undefined;
                break;
            case "describe:start":
                if (this.#describeResult) {
                    this.#describeResult.results.push(payload.result);
                }
                else {
                    this.#taskResult.results.push(payload.result);
                }
                this.#describeResult = payload.result;
                this.#describeResult.timing.start = Date.now();
                break;
            case "describe:end":
                this.#describeResult.timing.end = Date.now();
                this.#describeResult = this.#describeResult.parent;
                break;
            case "test:start":
                if (this.#describeResult) {
                    this.#describeResult.results.push(payload.result);
                }
                else {
                    this.#taskResult.results.push(payload.result);
                }
                this.#testResult = payload.result;
                this.#testResult.timing.start = Date.now();
                break;
            case "test:error":
                this.#result.testCount.failed++;
                this.#taskResult.testCount.failed++;
                this.#testResult.status = "failed";
                this.#testResult.diagnostics.push(...payload.diagnostics);
                this.#testResult.timing.end = Date.now();
                this.#testResult = undefined;
                break;
            case "test:fail":
                this.#result.testCount.failed++;
                this.#taskResult.testCount.failed++;
                this.#testResult.status = "failed";
                this.#testResult.timing.end = Date.now();
                this.#testResult = undefined;
                break;
            case "test:pass":
                this.#result.testCount.passed++;
                this.#taskResult.testCount.passed++;
                this.#testResult.status = "passed";
                this.#testResult.timing.end = Date.now();
                this.#testResult = undefined;
                break;
            case "test:skip":
                this.#result.testCount.skipped++;
                this.#taskResult.testCount.skipped++;
                this.#testResult.status = "skipped";
                this.#testResult.timing.end = Date.now();
                this.#testResult = undefined;
                break;
            case "test:todo":
                this.#result.testCount.todo++;
                this.#taskResult.testCount.todo++;
                this.#testResult.status = "todo";
                this.#testResult.timing.end = Date.now();
                this.#testResult = undefined;
                break;
            case "expect:start":
                if (this.#testResult) {
                    this.#testResult.results.push(payload.result);
                }
                else {
                    this.#taskResult.results.push(payload.result);
                }
                this.#expectResult = payload.result;
                this.#expectResult.timing.start = Date.now();
                break;
            case "expect:error":
                this.#result.expectCount.failed++;
                this.#taskResult.expectCount.failed++;
                if (this.#testResult) {
                    this.#testResult.expectCount.failed++;
                }
                this.#expectResult.status = "failed";
                this.#expectResult.diagnostics.push(...payload.diagnostics);
                this.#expectResult.timing.end = Date.now();
                this.#expectResult = undefined;
                break;
            case "expect:fail":
                this.#result.expectCount.failed++;
                this.#taskResult.expectCount.failed++;
                if (this.#testResult) {
                    this.#testResult.expectCount.failed++;
                }
                this.#expectResult.status = "failed";
                this.#expectResult.timing.end = Date.now();
                this.#expectResult = undefined;
                break;
            case "expect:pass":
                this.#result.expectCount.passed++;
                this.#taskResult.expectCount.passed++;
                if (this.#testResult) {
                    this.#testResult.expectCount.passed++;
                }
                this.#expectResult.status = "passed";
                this.#expectResult.timing.end = Date.now();
                this.#expectResult = undefined;
                break;
            case "expect:skip":
                this.#result.expectCount.skipped++;
                this.#taskResult.expectCount.skipped++;
                if (this.#testResult) {
                    this.#testResult.expectCount.skipped++;
                }
                this.#expectResult.status = "skipped";
                this.#expectResult.timing.end = Date.now();
                this.#expectResult = undefined;
                break;
        }
    }
}

function jsx(type, props) {
    return { props, type };
}

var Color;
(function (Color) {
    Color["Reset"] = "0";
    Color["Red"] = "31";
    Color["Green"] = "32";
    Color["Yellow"] = "33";
    Color["Blue"] = "34";
    Color["Magenta"] = "35";
    Color["Cyan"] = "36";
    Color["Gray"] = "90";
})(Color || (Color = {}));

function Text({ children, color, indent }) {
    const ansiEscapes = [];
    if (color != null) {
        ansiEscapes.push(color);
    }
    return (jsx("text", { indent: indent ?? 0, children: [ansiEscapes.length > 0 ? jsx("ansi", { escapes: ansiEscapes }) : undefined, children, ansiEscapes.length > 0 ? jsx("ansi", { escapes: "0" }) : undefined] }));
}

function Line({ children, color, indent }) {
    return (jsx(Text, { color: color, indent: indent, children: [children, jsx("newLine", {})] }));
}

class Scribbler {
    #indentStep = "  ";
    #newLine;
    #noColor;
    #notEmptyLineRegex = /^(?!$)/gm;
    constructor(options) {
        this.#newLine = options?.newLine ?? "\n";
        this.#noColor = options?.noColor ?? false;
    }
    #escapeSequence(attributes) {
        return ["\u001B[", Array.isArray(attributes) ? attributes.join(";") : attributes, "m"].join("");
    }
    #indentEachLine(lines, level) {
        if (level === 0) {
            return lines;
        }
        return lines.replace(this.#notEmptyLineRegex, this.#indentStep.repeat(level));
    }
    render(element) {
        if (typeof element.type === "function") {
            return this.render(element.type({ ...element.props }));
        }
        if (element.type === "ansi" && !this.#noColor) {
            return this.#escapeSequence(element.props.escapes);
        }
        if (element.type === "newLine") {
            return this.#newLine;
        }
        if (element.type === "text") {
            const text = this.#visitChildren(element.props.children);
            return this.#indentEachLine(text, element.props.indent);
        }
        return "";
    }
    #visitChildren(children) {
        const text = [];
        for (const child of children) {
            if (typeof child === "string" || typeof child === "number") {
                text.push(child);
                continue;
            }
            if (Array.isArray(child)) {
                text.push(this.#visitChildren(child));
                continue;
            }
            if (child != null && typeof child === "object") {
                text.push(this.render(child));
            }
        }
        return text.join("");
    }
}

function addsPackageText(packageVersion, packagePath) {
    return (jsx(Line, { children: [jsx(Text, { color: "90", children: "adds" }), " TypeScript ", packageVersion, jsx(Text, { color: "90", children: [" to ", packagePath] })] }));
}

function describeNameText(name, indent = 0) {
    return jsx(Line, { indent: indent + 1, children: name });
}

class Path {
    static normalizeSlashes;
    static {
        if (path.sep === "/") {
            Path.normalizeSlashes = (filePath) => filePath;
        }
        else {
            Path.normalizeSlashes = (filePath) => filePath.replace(/\\/g, "/");
        }
    }
    static dirname(filePath) {
        return Path.normalizeSlashes(path.dirname(filePath));
    }
    static join(...filePaths) {
        return Path.normalizeSlashes(path.join(...filePaths));
    }
    static relative(from, to) {
        let relativePath = path.relative(from, to);
        if (!relativePath.startsWith("./")) {
            relativePath = `./${relativePath}`;
        }
        return Path.normalizeSlashes(relativePath);
    }
    static resolve(...filePaths) {
        return Path.normalizeSlashes(path.resolve(...filePaths));
    }
}

function BreadcrumbsText({ ancestor }) {
    const text = [];
    while ("name" in ancestor) {
        text.push(ancestor.name);
        ancestor = ancestor.parent;
    }
    text.push("");
    return jsx(Text, { color: "90", children: text.reverse().join(" ❭ ") });
}
function CodeLineText({ gutterWidth, lineNumber, lineNumberColor = "90", lineText }) {
    return (jsx(Line, { children: [jsx(Text, { color: lineNumberColor, children: lineNumber.toString().padStart(gutterWidth) }), jsx(Text, { color: "90", children: " | " }), lineText] }));
}
function SquiggleLineText({ gutterWidth, indentWidth = 0, squiggleColor, squiggleWidth }) {
    return (jsx(Line, { children: [" ".repeat(gutterWidth), jsx(Text, { color: "90", children: " | " }), " ".repeat(indentWidth), jsx(Text, { color: squiggleColor, children: "~".repeat(squiggleWidth === 0 ? 1 : squiggleWidth) })] }));
}
function CodeSpanText({ diagnosticCategory, diagnosticOrigin }) {
    const lineMap = diagnosticOrigin.sourceFile.getLineStarts();
    const { character: firstMarkedLineCharacter, line: firstMarkedLine } = diagnosticOrigin.sourceFile.getLineAndCharacterOfPosition(diagnosticOrigin.start);
    const { character: lastMarkedLineCharacter, line: lastMarkedLine } = diagnosticOrigin.sourceFile.getLineAndCharacterOfPosition(diagnosticOrigin.end);
    const firstLine = Math.max(firstMarkedLine - 2, 0);
    const lastLine = Math.min(firstLine + 5, lineMap.length - 1);
    const gutterWidth = (lastLine + 1).toString().length + 2;
    let highlightColor;
    switch (diagnosticCategory) {
        case "error":
            highlightColor = "31";
            break;
        case "warning":
            highlightColor = "33";
            break;
    }
    const codeSpan = [];
    for (let index = firstLine; index <= lastLine; index++) {
        const lineStart = lineMap[index];
        const lineEnd = index === lineMap.length - 1 ? diagnosticOrigin.sourceFile.text.length : lineMap[index + 1];
        const lineText = diagnosticOrigin.sourceFile.text.slice(lineStart, lineEnd).trimEnd().replace(/\t/g, " ");
        if (index >= firstMarkedLine && index <= lastMarkedLine) {
            codeSpan.push(jsx(CodeLineText, { gutterWidth: gutterWidth, lineNumber: index + 1, lineNumberColor: highlightColor, lineText: lineText }));
            if (index === firstMarkedLine) {
                const squiggleLength = index === lastMarkedLine
                    ? lastMarkedLineCharacter - firstMarkedLineCharacter
                    : lineText.length - firstMarkedLineCharacter;
                codeSpan.push(jsx(SquiggleLineText, { gutterWidth: gutterWidth, indentWidth: firstMarkedLineCharacter, squiggleColor: highlightColor, squiggleWidth: squiggleLength }));
            }
            else if (index === lastMarkedLine) {
                codeSpan.push(jsx(SquiggleLineText, { gutterWidth: gutterWidth, squiggleColor: highlightColor, squiggleWidth: lastMarkedLineCharacter }));
            }
            else {
                codeSpan.push(jsx(SquiggleLineText, { gutterWidth: gutterWidth, squiggleColor: highlightColor, squiggleWidth: lineText.length }));
            }
        }
        else {
            codeSpan.push(jsx(CodeLineText, { gutterWidth: gutterWidth, lineNumber: index + 1, lineText: lineText }));
        }
    }
    const location = (jsx(Line, { children: [" ".repeat(gutterWidth + 2), jsx(Text, { color: "90", children: " at " }), jsx(Text, { color: "36", children: Path.relative("", diagnosticOrigin.sourceFile.fileName) }), jsx(Text, { color: "90", children: `:${firstMarkedLine + 1}:${firstMarkedLineCharacter + 1}` }), diagnosticOrigin.assertion && jsx(BreadcrumbsText, { ancestor: diagnosticOrigin.assertion.parent })] }));
    return (jsx(Text, { children: [codeSpan, jsx(Line, {}), location] }));
}

function DiagnosticText({ diagnostic }) {
    const code = diagnostic.code ? jsx(Text, { color: "90", children: [" ", diagnostic.code] }) : undefined;
    const text = Array.isArray(diagnostic.text) ? diagnostic.text : [diagnostic.text];
    const message = text.map((text, index) => (jsx(Text, { children: [index === 1 ? jsx(Line, {}) : undefined, jsx(Line, { children: [text, code] })] })));
    const related = diagnostic.related?.map((relatedDiagnostic) => jsx(DiagnosticText, { diagnostic: relatedDiagnostic }));
    const codeSpan = diagnostic.origin ? (jsx(Text, { children: [jsx(Line, {}), jsx(CodeSpanText, { diagnosticCategory: diagnostic.category, diagnosticOrigin: diagnostic.origin })] })) : undefined;
    return (jsx(Text, { children: [message, codeSpan, jsx(Line, {}), jsx(Text, { indent: 2, children: related })] }));
}
function diagnosticText(diagnostic) {
    let prefix;
    switch (diagnostic.category) {
        case "error":
            prefix = jsx(Text, { color: "31", children: "Error: " });
            break;
        case "warning":
            prefix = jsx(Text, { color: "33", children: "Warning: " });
            break;
    }
    return (jsx(Text, { children: [prefix, jsx(DiagnosticText, { diagnostic: diagnostic })] }));
}

function FileNameText({ filePath }) {
    const relativePath = Path.relative("", filePath);
    const lastPathSeparator = relativePath.lastIndexOf("/");
    const directoryNameText = relativePath.slice(0, lastPathSeparator + 1);
    const fileNameText = relativePath.slice(lastPathSeparator + 1);
    return (jsx(Text, { children: [jsx(Text, { color: "90", children: directoryNameText }), fileNameText] }));
}
function taskStatusText(status, task) {
    let statusColor;
    let statusText;
    switch (status) {
        case "runs":
            statusColor = "33";
            statusText = "runs";
            break;
        case "passed":
            statusColor = "32";
            statusText = "pass";
            break;
        case "failed":
            statusColor = "31";
            statusText = "fail";
            break;
    }
    return (jsx(Line, { children: [jsx(Text, { color: statusColor, children: statusText }), " ", jsx(FileNameText, { filePath: task.filePath })] }));
}

function fileViewText(lines, addEmptyFinalLine) {
    return (jsx(Text, { children: [[...lines], addEmptyFinalLine ? jsx(Line, {}) : undefined] }));
}

function formattedText(input) {
    if (typeof input === "string") {
        return jsx(Line, { children: input });
    }
    if (Array.isArray(input)) {
        return jsx(Line, { children: JSON.stringify(input, null, 2) });
    }
    function sortObject(target) {
        return Object.keys(target)
            .sort()
            .reduce((result, key) => {
            result[key] = target[key];
            return result;
        }, {});
    }
    return jsx(Line, { children: JSON.stringify(sortObject(input), null, 2) });
}

function HintText({ children }) {
    return (jsx(Text, { indent: 1, color: "90", children: children }));
}
function HelpHeaderText({ tstycheVersion }) {
    return (jsx(Line, { children: ["The TSTyche Type Test Runner", jsx(HintText, { children: tstycheVersion })] }));
}
function CommandText({ hint, text }) {
    return (jsx(Line, { indent: 1, children: [jsx(Text, { color: "34", children: text }), hint && jsx(HintText, { children: hint })] }));
}
function OptionDescriptionText({ text }) {
    return jsx(Line, { indent: 1, children: text });
}
function CommandLineUsageText() {
    const usage = [
        ["tstyche", "Run all tests."],
        ["tstyche path/to/first.test.ts", "Only run the test files with matching path."],
        ["tstyche --target 4.9,5.3.2,current", "Test on all specified versions of TypeScript."],
    ];
    const usageText = usage.map(([commandText, descriptionText]) => (jsx(Line, { children: [jsx(CommandText, { text: commandText }), jsx(OptionDescriptionText, { text: descriptionText })] })));
    return jsx(Text, { children: usageText });
}
function CommandLineOptionNameText({ text }) {
    return jsx(Text, { children: `--${text}` });
}
function CommandLineOptionHintText({ definition }) {
    if (definition.brand === "list") {
        return jsx(Text, { children: `${definition.brand} of ${definition.items.brand}s` });
    }
    return jsx(Text, { children: definition.brand });
}
function CommandLineOptionsText({ optionDefinitions }) {
    const definitions = [...optionDefinitions.values()];
    const optionsText = definitions.map((definition) => {
        let hint;
        if (definition.brand !== "bareTrue") {
            hint = jsx(CommandLineOptionHintText, { definition: definition });
        }
        return (jsx(Text, { children: [jsx(CommandText, { text: jsx(CommandLineOptionNameText, { text: definition.name }), hint: hint }), jsx(OptionDescriptionText, { text: definition.description }), jsx(Line, {})] }));
    });
    return (jsx(Text, { children: [jsx(Line, { children: "Command Line Options" }), jsx(Line, {}), optionsText] }));
}
function HelpFooterText() {
    return jsx(Line, { children: "To learn more, visit https://tstyche.org" });
}
function helpText(optionDefinitions, tstycheVersion) {
    return (jsx(Text, { children: [jsx(HelpHeaderText, { tstycheVersion: tstycheVersion }), jsx(Line, {}), jsx(CommandLineUsageText, {}), jsx(Line, {}), jsx(CommandLineOptionsText, { optionDefinitions: optionDefinitions }), jsx(Line, {}), jsx(HelpFooterText, {}), jsx(Line, {})] }));
}

class ConfigDiagnosticText {
    static expected(element) {
        return `Expected ${element}.`;
    }
    static expectsListItemType(optionName, optionBrand) {
        return `Item of the '${optionName}' list must be of type ${optionBrand}.`;
    }
    static expectsValue(optionName, optionGroup) {
        optionName = ConfigDiagnosticText.#optionName(optionName, optionGroup);
        return `Option '${optionName}' expects a value.`;
    }
    static fileDoesNotExist(filePath) {
        return `The specified path '${filePath}' does not exist.`;
    }
    static #optionName(optionName, optionGroup) {
        switch (optionGroup) {
            case 2:
                return `--${optionName}`;
            case 4:
                return optionName;
        }
    }
    static seen(element) {
        return `The ${element} was seen here.`;
    }
    static testFileMatchCannotStartWith(segment) {
        return [
            `A test file match pattern cannot start with '${segment}'.`,
            "The test files are only collected within the 'rootPath' directory.",
        ];
    }
    static requiresValueType(optionName, optionBrand, optionGroup) {
        optionName = ConfigDiagnosticText.#optionName(optionName, optionGroup);
        return `Option '${optionName}' requires a value of type ${optionBrand}.`;
    }
    static unknownOption(optionName) {
        return `Unknown option '${optionName}'.`;
    }
    static versionIsNotSupported(value) {
        if (value === "current") {
            return "Cannot use 'current' as a target. Failed to resolve the path to the currently installed TypeScript module.";
        }
        return `TypeScript version '${value}' is not supported.`;
    }
    static watchCannotBeEnabled() {
        return "The watch mode cannot be enabled in a continuous integration environment.";
    }
}

class DiagnosticOrigin {
    assertion;
    end;
    sourceFile;
    start;
    constructor(start, end, sourceFile, assertion) {
        this.start = start;
        this.end = end;
        this.sourceFile = sourceFile;
        this.assertion = assertion;
    }
    static fromAssertion(assertion) {
        const node = assertion.matcherName;
        return new DiagnosticOrigin(node.getStart(), node.getEnd(), node.getSourceFile(), assertion);
    }
    static fromNode(node, assertion) {
        return new DiagnosticOrigin(node.getStart(), node.getEnd(), node.getSourceFile(), assertion);
    }
}

class Diagnostic {
    category;
    code;
    origin;
    related;
    text;
    constructor(text, category, origin) {
        this.text = text;
        this.category = category;
        this.origin = origin;
    }
    add(options) {
        if (options.code != null) {
            this.code = options.code;
        }
        if (options.related != null) {
            this.related = options.related;
        }
        return this;
    }
    static error(text, origin) {
        return new Diagnostic(text, "error", origin);
    }
    extendWith(text, origin) {
        return new Diagnostic([this.text, text].flat(), this.category, origin ?? this.origin);
    }
    static fromDiagnostics(diagnostics, compiler) {
        return diagnostics.map((diagnostic) => {
            const code = `ts(${diagnostic.code})`;
            let origin;
            if (Diagnostic.#isTsDiagnosticWithLocation(diagnostic)) {
                origin = new DiagnosticOrigin(diagnostic.start, diagnostic.start + diagnostic.length, diagnostic.file);
            }
            let related;
            if (diagnostic.relatedInformation != null) {
                related = Diagnostic.fromDiagnostics(diagnostic.relatedInformation, compiler);
            }
            const text = compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            return new Diagnostic(text, "error", origin).add({ code, related });
        });
    }
    static #isTsDiagnosticWithLocation(diagnostic) {
        return diagnostic.file != null && diagnostic.start != null && diagnostic.length != null;
    }
    static warning(text, origin) {
        return new Diagnostic(text, "warning", origin);
    }
}

var DiagnosticCategory;
(function (DiagnosticCategory) {
    DiagnosticCategory["Error"] = "error";
    DiagnosticCategory["Warning"] = "warning";
})(DiagnosticCategory || (DiagnosticCategory = {}));

class SourceFile {
    fileName;
    #lineMap;
    text;
    constructor(fileName, text) {
        this.fileName = fileName;
        this.text = text;
        this.#lineMap = this.#createLineMap();
    }
    #createLineMap() {
        const result = [0];
        let position = 0;
        while (position < this.text.length) {
            if (this.text.charAt(position - 1) === "\r") {
                position++;
            }
            if (this.text.charAt(position - 1) === "\n") {
                result.push(position);
            }
            position++;
        }
        result.push(position);
        return result;
    }
    getLineStarts() {
        return this.#lineMap;
    }
    getLineAndCharacterOfPosition(position) {
        const line = this.#lineMap.findLastIndex((line) => line <= position);
        const character = position - this.#lineMap[line];
        return { line, character };
    }
}

class OptionDefinitionsMap {
    static #definitions = [
        {
            brand: "string",
            description: "The Url to the config file validation schema.",
            group: 4,
            name: "$schema",
        },
        {
            brand: "string",
            description: "The path to a TSTyche configuration file.",
            group: 2,
            name: "config",
        },
        {
            brand: "boolean",
            description: "Stop running tests after the first failed assertion.",
            group: 4 | 2,
            name: "failFast",
        },
        {
            brand: "bareTrue",
            description: "Print the list of command line options with brief descriptions and exit.",
            group: 2,
            name: "help",
        },
        {
            brand: "bareTrue",
            description: "Install specified versions of the 'typescript' package and exit.",
            group: 2,
            name: "install",
        },
        {
            brand: "bareTrue",
            description: "Print the list of the selected test files and exit.",
            group: 2,
            name: "listFiles",
        },
        {
            brand: "string",
            description: "Only run tests with matching name.",
            group: 2,
            name: "only",
        },
        {
            brand: "bareTrue",
            description: "Remove all installed versions of the 'typescript' package and exit.",
            group: 2,
            name: "prune",
        },
        {
            brand: "string",
            description: "The path to a directory containing files of a test project.",
            group: 4,
            name: "rootPath",
        },
        {
            brand: "bareTrue",
            description: "Print the resolved configuration and exit.",
            group: 2,
            name: "showConfig",
        },
        {
            brand: "string",
            description: "Skip tests with matching name.",
            group: 2,
            name: "skip",
        },
        {
            brand: "list",
            description: "The list of TypeScript versions to be tested on.",
            group: 2 | 4,
            items: {
                brand: "string",
                name: "target",
                pattern: "^([45]\\.[0-9](\\.[0-9])?)|beta|current|latest|next|rc$",
            },
            name: "target",
        },
        {
            brand: "list",
            description: "The list of glob patterns matching the test files.",
            group: 4,
            items: {
                brand: "string",
                name: "testFileMatch",
            },
            name: "testFileMatch",
        },
        {
            brand: "bareTrue",
            description: "Fetch the 'typescript' package metadata from the registry and exit.",
            group: 2,
            name: "update",
        },
        {
            brand: "bareTrue",
            description: "Print the version number and exit.",
            group: 2,
            name: "version",
        },
        {
            brand: "bareTrue",
            description: "Watch for changes and rerun related test files.",
            group: 2,
            name: "watch",
        },
    ];
    static for(optionGroup) {
        const definitionMap = new Map();
        for (const definition of OptionDefinitionsMap.#definitions) {
            if (definition.group & optionGroup) {
                definitionMap.set(definition.name, definition);
            }
        }
        return definitionMap;
    }
}

class OptionUsageText {
    #optionGroup;
    #storeService;
    constructor(optionGroup, storeService) {
        this.#optionGroup = optionGroup;
        this.#storeService = storeService;
    }
    async get(optionName, optionBrand) {
        const usageText = [];
        switch (optionName) {
            case "target": {
                switch (this.#optionGroup) {
                    case 2:
                        usageText.push("Value for the '--target' option must be a single tag or a comma separated list.", "Usage examples: '--target 4.9', '--target latest', '--target 4.9,5.3.2,current'.");
                        break;
                    case 4:
                        usageText.push("Item of the 'target' list must be a supported version tag.");
                        break;
                }
                const supportedTags = await this.#storeService.getSupportedTags();
                if (supportedTags != null) {
                    usageText.push(`Supported tags: ${["'", supportedTags.join("', '"), "'"].join("")}.`);
                }
                break;
            }
            default:
                usageText.push(ConfigDiagnosticText.requiresValueType(optionName, optionBrand, this.#optionGroup));
        }
        return usageText;
    }
}

class EnvironmentService {
    static resolve() {
        return {
            isCi: EnvironmentService.#resolveIsCi(),
            noColor: EnvironmentService.#resolveNoColor(),
            noInteractive: EnvironmentService.#resolveNoInteractive(),
            npmRegistry: EnvironmentService.#resolveNpmRegistry(),
            storePath: EnvironmentService.#resolveStorePath(),
            timeout: EnvironmentService.#resolveTimeout(),
            typescriptPath: EnvironmentService.#resolveTypeScriptPath(),
        };
    }
    static #resolveIsCi() {
        if (process.env["CI"] != null) {
            return process.env["CI"] !== "";
        }
        return false;
    }
    static #resolveNoColor() {
        if (process.env["TSTYCHE_NO_COLOR"] != null) {
            return process.env["TSTYCHE_NO_COLOR"] !== "";
        }
        if (process.env["NO_COLOR"] != null) {
            return process.env["NO_COLOR"] !== "";
        }
        return false;
    }
    static #resolveNoInteractive() {
        if (process.env["TSTYCHE_NO_INTERACTIVE"] != null) {
            return process.env["TSTYCHE_NO_INTERACTIVE"] !== "";
        }
        return !process.stdout.isTTY;
    }
    static #resolveNpmRegistry() {
        if (process.env["TSTYCHE_NPM_REGISTRY"] != null) {
            return process.env["TSTYCHE_NPM_REGISTRY"];
        }
        return "https://registry.npmjs.org";
    }
    static #resolveStorePath() {
        if (process.env["TSTYCHE_STORE_PATH"] != null) {
            return Path.resolve(process.env["TSTYCHE_STORE_PATH"]);
        }
        if (process.platform === "darwin") {
            return Path.resolve(os.homedir(), "Library", "TSTyche");
        }
        if (process.env["LocalAppData"] != null) {
            return Path.resolve(process.env["LocalAppData"], "TSTyche");
        }
        if (process.env["XDG_DATA_HOME"] != null) {
            return Path.resolve(process.env["XDG_DATA_HOME"], "TSTyche");
        }
        return Path.resolve(os.homedir(), ".local", "share", "TSTyche");
    }
    static #resolveTimeout() {
        if (process.env["TSTYCHE_TIMEOUT"] != null) {
            return Number.parseFloat(process.env["TSTYCHE_TIMEOUT"]);
        }
        return 30;
    }
    static #resolveTypeScriptPath() {
        let specifier = "typescript";
        if (process.env["TSTYCHE_TYPESCRIPT_PATH"] != null) {
            specifier = process.env["TSTYCHE_TYPESCRIPT_PATH"];
        }
        let resolvedPath;
        try {
            resolvedPath = Path.normalizeSlashes(createRequire(import.meta.url).resolve(specifier));
        }
        catch {
        }
        return resolvedPath;
    }
}

const environmentOptions = EnvironmentService.resolve();

class OptionValidator {
    #onDiagnostics;
    #optionGroup;
    #optionUsageText;
    #storeService;
    constructor(optionGroup, storeService, onDiagnostics) {
        this.#optionGroup = optionGroup;
        this.#storeService = storeService;
        this.#onDiagnostics = onDiagnostics;
        this.#optionUsageText = new OptionUsageText(this.#optionGroup, this.#storeService);
    }
    async check(optionName, optionValue, optionBrand, origin) {
        switch (optionName) {
            case "config":
            case "rootPath":
                if (!existsSync(optionValue)) {
                    this.#onDiagnostics(Diagnostic.error(ConfigDiagnosticText.fileDoesNotExist(optionValue), origin));
                }
                break;
            case "target":
                if ((await this.#storeService.validateTag(optionValue)) === false) {
                    this.#onDiagnostics(Diagnostic.error([
                        ConfigDiagnosticText.versionIsNotSupported(optionValue),
                        ...(await this.#optionUsageText.get(optionName, optionBrand)),
                    ], origin));
                }
                break;
            case "testFileMatch":
                for (const segment of ["/", "../"]) {
                    if (optionValue.startsWith(segment)) {
                        this.#onDiagnostics(Diagnostic.error(ConfigDiagnosticText.testFileMatchCannotStartWith(segment), origin));
                    }
                }
                break;
            case "watch":
                if (environmentOptions.isCi) {
                    this.#onDiagnostics(Diagnostic.error(ConfigDiagnosticText.watchCannotBeEnabled(), origin));
                }
                break;
        }
    }
}

class CommandLineOptionsWorker {
    #commandLineOptionDefinitions;
    #commandLineOptions;
    #onDiagnostics;
    #optionGroup = 2;
    #optionUsageText;
    #optionValidator;
    #pathMatch;
    #storeService;
    constructor(commandLineOptions, pathMatch, storeService, onDiagnostics) {
        this.#commandLineOptions = commandLineOptions;
        this.#pathMatch = pathMatch;
        this.#storeService = storeService;
        this.#onDiagnostics = onDiagnostics;
        this.#commandLineOptionDefinitions = OptionDefinitionsMap.for(this.#optionGroup);
        this.#optionUsageText = new OptionUsageText(this.#optionGroup, this.#storeService);
        this.#optionValidator = new OptionValidator(this.#optionGroup, this.#storeService, this.#onDiagnostics);
    }
    async #onExpectsValue(optionDefinition) {
        const text = [
            ConfigDiagnosticText.expectsValue(optionDefinition.name, this.#optionGroup),
            ...(await this.#optionUsageText.get(optionDefinition.name, optionDefinition.brand)),
        ];
        this.#onDiagnostics(Diagnostic.error(text));
    }
    async parse(commandLineArgs) {
        let index = 0;
        let arg = commandLineArgs[index];
        while (arg != null) {
            index++;
            if (arg.startsWith("--")) {
                const optionName = arg.slice(2);
                const optionDefinition = this.#commandLineOptionDefinitions.get(optionName);
                if (optionDefinition) {
                    index = await this.#parseOptionValue(commandLineArgs, index, optionDefinition);
                }
                else {
                    this.#onDiagnostics(Diagnostic.error(ConfigDiagnosticText.unknownOption(arg)));
                }
            }
            else if (arg.startsWith("-")) {
                this.#onDiagnostics(Diagnostic.error(ConfigDiagnosticText.unknownOption(arg)));
            }
            else {
                this.#pathMatch.push(Path.normalizeSlashes(arg));
            }
            arg = commandLineArgs[index];
        }
    }
    async #parseOptionValue(commandLineArgs, index, optionDefinition) {
        let optionValue = this.#resolveOptionValue(commandLineArgs[index]);
        switch (optionDefinition.brand) {
            case "bareTrue":
                await this.#optionValidator.check(optionDefinition.name, optionValue, optionDefinition.brand);
                this.#commandLineOptions[optionDefinition.name] = true;
                break;
            case "boolean":
                await this.#optionValidator.check(optionDefinition.name, optionValue, optionDefinition.brand);
                this.#commandLineOptions[optionDefinition.name] = optionValue !== "false";
                if (optionValue === "false" || optionValue === "true") {
                    index++;
                }
                break;
            case "list":
                if (optionValue !== "") {
                    const optionValues = optionValue
                        .split(",")
                        .map((value) => value.trim())
                        .filter((value) => value !== "");
                    for (const optionValue of optionValues) {
                        await this.#optionValidator.check(optionDefinition.name, optionValue, optionDefinition.brand);
                    }
                    this.#commandLineOptions[optionDefinition.name] = optionValues;
                    index++;
                    break;
                }
                await this.#onExpectsValue(optionDefinition);
                break;
            case "string":
                if (optionValue !== "") {
                    if (optionDefinition.name === "config") {
                        optionValue = Path.resolve(optionValue);
                    }
                    await this.#optionValidator.check(optionDefinition.name, optionValue, optionDefinition.brand);
                    this.#commandLineOptions[optionDefinition.name] = optionValue;
                    index++;
                    break;
                }
                await this.#onExpectsValue(optionDefinition);
                break;
        }
        return index;
    }
    #resolveOptionValue(target = "") {
        return target.startsWith("-") ? "" : target;
    }
}

class JsonNode {
    origin;
    text;
    constructor(text, origin) {
        this.origin = origin;
        this.text = text;
    }
    getValue(options) {
        if (this.text == null) {
            return undefined;
        }
        if (/^['"]/.test(this.text)) {
            return this.text.slice(1, -1);
        }
        if (options?.expectsIdentifier) {
            return this.text;
        }
        if (this.text === "true") {
            return true;
        }
        if (this.text === "false") {
            return false;
        }
        if (/^\d/.test(this.text)) {
            return Number.parseFloat(this.text);
        }
        return undefined;
    }
}

class JsonScanner {
    #currentPosition = 0;
    #previousPosition = 0;
    #sourceFile;
    constructor(sourceFile) {
        this.#sourceFile = sourceFile;
    }
    #getOrigin() {
        return new DiagnosticOrigin(this.#previousPosition, this.#currentPosition, this.#sourceFile);
    }
    isRead() {
        return !(this.#currentPosition < this.#sourceFile.text.length);
    }
    #peekCharacter() {
        return this.#sourceFile.text.charAt(this.#currentPosition);
    }
    #peekNextCharacter() {
        return this.#sourceFile.text.charAt(this.#currentPosition + 1);
    }
    peekToken(token) {
        this.#skipTrivia();
        return this.#peekCharacter() === token;
    }
    read() {
        this.#skipTrivia();
        this.#previousPosition = this.#currentPosition;
        if (/[\s,:\]}]/.test(this.#peekCharacter())) {
            return new JsonNode(undefined, this.#getOrigin());
        }
        let text = "";
        let closingTokenText = "";
        if (/[[{'"]/.test(this.#peekCharacter())) {
            text += this.#readCharacter();
            switch (text) {
                case "[":
                    closingTokenText = "]";
                    break;
                case "{":
                    closingTokenText = "}";
                    break;
                default:
                    closingTokenText = text;
            }
        }
        while (!this.isRead()) {
            text += this.#readCharacter();
            if (text.slice(-1) === closingTokenText || (!closingTokenText && /[\s,:\]}]/.test(this.#peekCharacter()))) {
                break;
            }
        }
        return new JsonNode(text, this.#getOrigin());
    }
    #readCharacter() {
        return this.#sourceFile.text.charAt(this.#currentPosition++);
    }
    readToken(token) {
        this.#skipTrivia();
        this.#previousPosition = this.#currentPosition;
        if (this.#peekCharacter() === token) {
            this.#currentPosition++;
            return new JsonNode(token, this.#getOrigin());
        }
        return new JsonNode(undefined, this.#getOrigin());
    }
    #skipTrivia() {
        while (!this.isRead()) {
            if (/\s/.test(this.#peekCharacter())) {
                this.#currentPosition++;
                continue;
            }
            if (this.#peekCharacter() === "/") {
                if (this.#peekNextCharacter() === "/") {
                    this.#currentPosition += 2;
                    while (!this.isRead()) {
                        if (this.#readCharacter() === "\n") {
                            break;
                        }
                    }
                    continue;
                }
                if (this.#peekNextCharacter() === "*") {
                    this.#currentPosition += 2;
                    while (!this.isRead()) {
                        if (this.#peekCharacter() === "*" && this.#peekNextCharacter() === "/") {
                            this.#currentPosition += 2;
                            break;
                        }
                        this.#currentPosition++;
                    }
                    continue;
                }
            }
            break;
        }
        this.#previousPosition = this.#currentPosition;
    }
}

class ConfigFileOptionsWorker {
    #configFileOptionDefinitions;
    #configFileOptions;
    #jsonScanner;
    #onDiagnostics;
    #optionGroup = 4;
    #optionValidator;
    #sourceFile;
    #storeService;
    constructor(configFileOptions, sourceFile, storeService, onDiagnostics) {
        this.#configFileOptions = configFileOptions;
        this.#sourceFile = sourceFile;
        this.#storeService = storeService;
        this.#onDiagnostics = onDiagnostics;
        this.#configFileOptionDefinitions = OptionDefinitionsMap.for(this.#optionGroup);
        this.#jsonScanner = new JsonScanner(this.#sourceFile);
        this.#optionValidator = new OptionValidator(this.#optionGroup, this.#storeService, this.#onDiagnostics);
    }
    #onRequiresValue(optionDefinition, jsonNode, isListItem) {
        const text = isListItem
            ? ConfigDiagnosticText.expectsListItemType(optionDefinition.name, optionDefinition.brand)
            : ConfigDiagnosticText.requiresValueType(optionDefinition.name, optionDefinition.brand, this.#optionGroup);
        this.#onDiagnostics(Diagnostic.error(text, jsonNode.origin));
    }
    async #parseValue(optionDefinition, isListItem = false) {
        let jsonNode;
        let optionValue;
        switch (optionDefinition.brand) {
            case "boolean": {
                jsonNode = this.#jsonScanner.read();
                optionValue = jsonNode.getValue();
                if (typeof optionValue !== "boolean") {
                    this.#onRequiresValue(optionDefinition, jsonNode, isListItem);
                    break;
                }
                break;
            }
            case "string": {
                jsonNode = this.#jsonScanner.read();
                optionValue = jsonNode.getValue();
                if (typeof optionValue !== "string") {
                    this.#onRequiresValue(optionDefinition, jsonNode, isListItem);
                    break;
                }
                if (optionDefinition.name === "rootPath") {
                    optionValue = Path.resolve(Path.dirname(this.#sourceFile.fileName), optionValue);
                }
                await this.#optionValidator.check(optionDefinition.name, optionValue, optionDefinition.brand, jsonNode.origin);
                break;
            }
            case "list": {
                const leftBracketToken = this.#jsonScanner.readToken("[");
                if (!leftBracketToken.text) {
                    jsonNode = this.#jsonScanner.read();
                    this.#onRequiresValue(optionDefinition, jsonNode, isListItem);
                    break;
                }
                optionValue = [];
                while (!this.#jsonScanner.isRead()) {
                    if (this.#jsonScanner.peekToken("]")) {
                        break;
                    }
                    const item = await this.#parseValue(optionDefinition.items, true);
                    if (item != null) {
                        optionValue.push(item);
                    }
                    const commaToken = this.#jsonScanner.readToken(",");
                    if (!commaToken.text) {
                        break;
                    }
                }
                const rightBracketToken = this.#jsonScanner.readToken("]");
                if (!rightBracketToken.text) {
                    const text = ConfigDiagnosticText.expected("closing ']'");
                    const relatedText = ConfigDiagnosticText.seen("opening '['");
                    const diagnostic = Diagnostic.error(text, rightBracketToken.origin).add({
                        related: [Diagnostic.error(relatedText, leftBracketToken.origin)],
                    });
                    this.#onDiagnostics(diagnostic);
                }
                break;
            }
        }
        return optionValue;
    }
    async #parseObject() {
        const leftBraceToken = this.#jsonScanner.readToken("{");
        if (this.#jsonScanner.isRead()) {
            return;
        }
        if (!leftBraceToken.text) {
            const text = ConfigDiagnosticText.expected("'{'");
            this.#onDiagnostics(Diagnostic.error(text, leftBraceToken.origin));
            return;
        }
        while (!this.#jsonScanner.isRead()) {
            if (this.#jsonScanner.peekToken("}")) {
                break;
            }
            const optionNameNode = this.#jsonScanner.read();
            const optionName = optionNameNode.getValue({ expectsIdentifier: true });
            if (!optionName) {
                const text = ConfigDiagnosticText.expected("option name");
                this.#onDiagnostics(Diagnostic.error(text, optionNameNode.origin));
                return;
            }
            const optionDefinition = this.#configFileOptionDefinitions.get(optionName);
            if (!optionDefinition) {
                const text = ConfigDiagnosticText.unknownOption(optionName);
                this.#onDiagnostics(Diagnostic.error(text, optionNameNode.origin));
                if (this.#jsonScanner.readToken(":")) {
                    this.#jsonScanner.read();
                }
                const commaToken = this.#jsonScanner.readToken(",");
                if (!commaToken.text) {
                    break;
                }
                continue;
            }
            if (this.#jsonScanner.peekToken(":")) {
                this.#jsonScanner.readToken(":");
            }
            const parsedValue = await this.#parseValue(optionDefinition);
            if (optionDefinition.name !== "$schema") {
                this.#configFileOptions[optionDefinition.name] = parsedValue;
            }
            const commaToken = this.#jsonScanner.readToken(",");
            if (!commaToken.text) {
                break;
            }
        }
        const rightBraceToken = this.#jsonScanner.readToken("}");
        if (!rightBraceToken.text) {
            const text = ConfigDiagnosticText.expected("closing '}'");
            const relatedText = ConfigDiagnosticText.seen("opening '{'");
            const diagnostic = Diagnostic.error(text, rightBraceToken.origin).add({
                related: [Diagnostic.error(relatedText, leftBraceToken.origin)],
            });
            this.#onDiagnostics(diagnostic);
        }
    }
    async parse() {
        await this.#parseObject();
    }
}

const defaultOptions = {
    failFast: false,
    rootPath: Path.resolve("./"),
    target: environmentOptions.typescriptPath != null ? ["current"] : ["latest"],
    testFileMatch: ["**/*.tst.*", "**/__typetests__/*.test.*", "**/typetests/*.test.*"],
};

class ConfigService {
    #commandLineOptions = {};
    #configFileOptions = {};
    #configFilePath = Path.resolve(defaultOptions.rootPath, "./tstyche.config.json");
    #pathMatch = [];
    #onDiagnostics(diagnostics) {
        EventEmitter.dispatch(["config:error", { diagnostics: [diagnostics] }]);
    }
    async parseCommandLine(commandLineArgs, storeService) {
        this.#commandLineOptions = {};
        this.#pathMatch = [];
        const commandLineWorker = new CommandLineOptionsWorker(this.#commandLineOptions, this.#pathMatch, storeService, this.#onDiagnostics);
        await commandLineWorker.parse(commandLineArgs);
        if (this.#commandLineOptions.config != null) {
            this.#configFilePath = this.#commandLineOptions.config;
            delete this.#commandLineOptions.config;
        }
    }
    async readConfigFile(storeService) {
        this.#configFileOptions = {
            rootPath: Path.dirname(this.#configFilePath),
        };
        if (!existsSync(this.#configFilePath)) {
            return;
        }
        const configFileText = await fs.readFile(this.#configFilePath, {
            encoding: "utf8",
        });
        const sourceFile = new SourceFile(this.#configFilePath, configFileText);
        const configFileWorker = new ConfigFileOptionsWorker(this.#configFileOptions, sourceFile, storeService, this.#onDiagnostics);
        await configFileWorker.parse();
    }
    resolveConfig() {
        return {
            ...defaultOptions,
            ...environmentOptions,
            ...this.#configFileOptions,
            ...this.#commandLineOptions,
            configFilePath: this.#configFilePath,
            pathMatch: this.#pathMatch,
        };
    }
}

var OptionBrand;
(function (OptionBrand) {
    OptionBrand["String"] = "string";
    OptionBrand["Number"] = "number";
    OptionBrand["Boolean"] = "boolean";
    OptionBrand["BareTrue"] = "bareTrue";
    OptionBrand["List"] = "list";
})(OptionBrand || (OptionBrand = {}));

var OptionGroup;
(function (OptionGroup) {
    OptionGroup[OptionGroup["CommandLine"] = 2] = "CommandLine";
    OptionGroup[OptionGroup["ConfigFile"] = 4] = "ConfigFile";
})(OptionGroup || (OptionGroup = {}));

class OutputService {
    #isClear = false;
    #noColor = environmentOptions.noColor;
    #scribbler;
    #stderr = process.stderr;
    #stdout = process.stdout;
    constructor() {
        this.#scribbler = new Scribbler({ noColor: this.#noColor });
    }
    clearTerminal() {
        if (!this.#isClear) {
            this.#stdout.write("\u001B[2J\u001B[3J\u001B[H");
            this.#isClear = true;
        }
    }
    eraseLastLine() {
        this.#stdout.write("\u001B[1A\u001B[0K");
    }
    #writeTo(stream, element) {
        const elements = Array.isArray(element) ? element : [element];
        for (const element of elements) {
            stream.write(this.#scribbler.render(element));
        }
        this.#isClear = false;
    }
    writeError(element) {
        this.#writeTo(this.#stderr, element);
    }
    writeMessage(element) {
        this.#writeTo(this.#stdout, element);
    }
    writeWarning(element) {
        this.#writeTo(this.#stderr, element);
    }
}

function RowText({ label, text }) {
    return (jsx(Line, { children: [`${label}:`.padEnd(12), text] }));
}
function CountText({ failed, passed, skipped, todo, total }) {
    return (jsx(Text, { children: [failed > 0 ? (jsx(Text, { children: [jsx(Text, { color: "31", children: [failed, " failed"] }), jsx(Text, { children: ", " })] })) : undefined, skipped > 0 ? (jsx(Text, { children: [jsx(Text, { color: "33", children: [skipped, " skipped"] }), jsx(Text, { children: ", " })] })) : undefined, todo > 0 ? (jsx(Text, { children: [jsx(Text, { color: "35", children: [todo, " todo"] }), jsx(Text, { children: ", " })] })) : undefined, passed > 0 ? (jsx(Text, { children: [jsx(Text, { color: "32", children: [passed, " passed"] }), jsx(Text, { children: ", " })] })) : undefined, jsx(Text, { children: [total, " total"] })] }));
}
function DurationText({ seconds }) {
    return jsx(Text, { children: `${Math.round(seconds * 10) / 10}s` });
}
function MatchText({ text }) {
    if (typeof text === "string") {
        return jsx(Text, { children: ["'", text, "'"] });
    }
    if (text.length === 1) {
        return jsx(Text, { children: ["'", ...text, "'"] });
    }
    const lastItem = text.pop();
    return (jsx(Text, { children: [text.map((match, index, list) => (jsx(Text, { children: ["'", match, "'", index === list.length - 1 ? jsx(Text, { children: " " }) : jsx(Text, { color: "90", children: ", " })] }))), jsx(Text, { color: "90", children: "or" }), " '", lastItem, "'"] }));
}
function RanFilesText({ onlyMatch, pathMatch, skipMatch }) {
    const testNameMatchText = [];
    if (onlyMatch != null) {
        testNameMatchText.push(jsx(Text, { children: [jsx(Text, { color: "90", children: "matching " }), jsx(MatchText, { text: onlyMatch })] }));
    }
    if (skipMatch != null) {
        testNameMatchText.push(jsx(Text, { children: [onlyMatch && jsx(Text, { color: "90", children: " and " }), jsx(Text, { color: "90", children: "not matching " }), jsx(MatchText, { text: skipMatch })] }));
    }
    let pathMatchText;
    if (pathMatch.length > 0) {
        pathMatchText = (jsx(Text, { children: [jsx(Text, { color: "90", children: "test files matching " }), jsx(MatchText, { text: pathMatch }), jsx(Text, { color: "90", children: "." })] }));
    }
    else {
        pathMatchText = jsx(Text, { color: "90", children: "all test files." });
    }
    return (jsx(Line, { children: [jsx(Text, { color: "90", children: "Ran " }), testNameMatchText.length > 0 ? jsx(Text, { color: "90", children: "tests " }) : undefined, testNameMatchText, testNameMatchText.length > 0 ? jsx(Text, { color: "90", children: " in " }) : undefined, pathMatchText] }));
}
function summaryText({ duration, expectCount, fileCount, onlyMatch, pathMatch, skipMatch, targetCount, testCount, }) {
    const targetCountText = (jsx(RowText, { label: "Targets", text: jsx(CountText, { failed: targetCount.failed, passed: targetCount.passed, skipped: targetCount.skipped, todo: targetCount.todo, total: targetCount.total }) }));
    const fileCountText = (jsx(RowText, { label: "Test files", text: jsx(CountText, { failed: fileCount.failed, passed: fileCount.passed, skipped: fileCount.skipped, todo: fileCount.todo, total: fileCount.total }) }));
    const testCountText = (jsx(RowText, { label: "Tests", text: jsx(CountText, { failed: testCount.failed, passed: testCount.passed, skipped: testCount.skipped, todo: testCount.todo, total: testCount.total }) }));
    const assertionCountText = (jsx(RowText, { label: "Assertions", text: jsx(CountText, { failed: expectCount.failed, passed: expectCount.passed, skipped: expectCount.skipped, todo: expectCount.todo, total: expectCount.total }) }));
    return (jsx(Text, { children: [targetCountText, fileCountText, testCount.total > 0 ? testCountText : undefined, expectCount.total > 0 ? assertionCountText : undefined, jsx(RowText, { label: "Duration", text: jsx(DurationText, { seconds: duration / 1000 }) }), jsx(Line, {}), jsx(RanFilesText, { onlyMatch: onlyMatch, pathMatch: pathMatch, skipMatch: skipMatch })] }));
}

function StatusText({ status }) {
    switch (status) {
        case "fail":
            return jsx(Text, { color: "31", children: "\u00D7" });
        case "pass":
            return jsx(Text, { color: "32", children: "+" });
        case "skip":
            return jsx(Text, { color: "33", children: "- skip" });
        case "todo":
            return jsx(Text, { color: "35", children: "- todo" });
    }
}
function testNameText(status, name, indent = 0) {
    return (jsx(Line, { indent: indent + 1, children: [jsx(StatusText, { status: status }), " ", jsx(Text, { color: "90", children: name })] }));
}

function usesCompilerText(compilerVersion, projectConfigFilePath, options) {
    let projectConfigPathText;
    if (projectConfigFilePath != null) {
        projectConfigPathText = (jsx(Text, { color: "90", children: [" with ", Path.relative("", projectConfigFilePath)] }));
    }
    return (jsx(Text, { children: [options?.prependEmptyLine === true ? jsx(Line, {}) : undefined, jsx(Line, { children: [jsx(Text, { color: "34", children: "uses" }), " TypeScript ", compilerVersion, projectConfigPathText] }), jsx(Line, {})] }));
}

function waitingForFileChangesText() {
    return jsx(Line, { children: "Waiting for file changes." });
}

function watchUsageText() {
    const usage = [
        ["a", "to run all tests."],
        ["x", "to exit."],
    ];
    const usageText = usage.map(([keyText, actionText]) => {
        return (jsx(Line, { children: [jsx(Text, { color: "90", children: "Press" }), jsx(Text, { children: ` ${keyText} ` }), jsx(Text, { color: "90", children: actionText })] }));
    });
    return jsx(Text, { children: usageText });
}

class FileViewService {
    #indent = 0;
    #lines = [];
    #messages = [];
    get hasErrors() {
        return this.#messages.length > 0;
    }
    addMessage(message) {
        this.#messages.push(message);
    }
    addTest(status, name) {
        this.#lines.push(testNameText(status, name, this.#indent));
    }
    beginDescribe(name) {
        this.#lines.push(describeNameText(name, this.#indent));
        this.#indent++;
    }
    clear() {
        this.#indent = 0;
        this.#lines = [];
        this.#messages = [];
    }
    endDescribe() {
        this.#indent--;
    }
    getMessages() {
        return this.#messages;
    }
    getViewText(options) {
        return fileViewText(this.#lines, options?.appendEmptyLine === true || this.hasErrors);
    }
}

class Reporter {
    outputService;
    constructor(outputService) {
        this.outputService = outputService;
    }
}

class RunReporter extends Reporter {
    #currentCompilerVersion;
    #currentProjectConfigFilePath;
    #fileCount = 0;
    #fileView = new FileViewService();
    #hasReportedAdds = false;
    #hasReportedError = false;
    #isFileViewExpanded = false;
    #resolvedConfig;
    #seenDeprecations = new Set();
    constructor(resolvedConfig, outputService) {
        super(outputService);
        this.#resolvedConfig = resolvedConfig;
    }
    get #isLastFile() {
        return this.#fileCount === 0;
    }
    handleEvent([eventName, payload]) {
        switch (eventName) {
            case "deprecation:info": {
                for (const diagnostic of payload.diagnostics) {
                    if (!this.#seenDeprecations.has(diagnostic.text.toString())) {
                        this.#fileView.addMessage(diagnosticText(diagnostic));
                        this.#seenDeprecations.add(diagnostic.text.toString());
                    }
                }
                break;
            }
            case "run:start":
                this.#isFileViewExpanded = payload.result.tasks.length === 1 && this.#resolvedConfig.watch !== true;
                break;
            case "store:adds":
                this.outputService.writeMessage(addsPackageText(payload.packageVersion, payload.packagePath));
                this.#hasReportedAdds = true;
                break;
            case "store:error":
                for (const diagnostic of payload.diagnostics) {
                    this.outputService.writeError(diagnosticText(diagnostic));
                }
                break;
            case "target:start":
                this.#fileCount = payload.result.tasks.length;
                break;
            case "target:end":
                this.#currentCompilerVersion = undefined;
                this.#currentProjectConfigFilePath = undefined;
                break;
            case "project:uses":
                if (this.#currentCompilerVersion !== payload.compilerVersion ||
                    this.#currentProjectConfigFilePath !== payload.projectConfigFilePath) {
                    this.outputService.writeMessage(usesCompilerText(payload.compilerVersion, payload.projectConfigFilePath, {
                        prependEmptyLine: this.#currentCompilerVersion != null && !this.#hasReportedAdds && !this.#hasReportedError,
                    }));
                    this.#hasReportedAdds = false;
                    this.#currentCompilerVersion = payload.compilerVersion;
                    this.#currentProjectConfigFilePath = payload.projectConfigFilePath;
                }
                break;
            case "project:error":
                for (const diagnostic of payload.diagnostics) {
                    this.outputService.writeError(diagnosticText(diagnostic));
                }
                break;
            case "task:start":
                if (!this.#resolvedConfig.noInteractive) {
                    this.outputService.writeMessage(taskStatusText(payload.result.status, payload.result.task));
                }
                this.#fileCount--;
                this.#hasReportedError = false;
                break;
            case "task:error":
                for (const diagnostic of payload.diagnostics) {
                    this.#fileView.addMessage(diagnosticText(diagnostic));
                }
                break;
            case "task:end":
                if (!this.#resolvedConfig.noInteractive) {
                    this.outputService.eraseLastLine();
                }
                this.outputService.writeMessage(taskStatusText(payload.result.status, payload.result.task));
                this.outputService.writeMessage(this.#fileView.getViewText({ appendEmptyLine: this.#isLastFile }));
                if (this.#fileView.hasErrors) {
                    this.outputService.writeError(this.#fileView.getMessages());
                    this.#hasReportedError = true;
                }
                this.#fileView.clear();
                this.#seenDeprecations.clear();
                break;
            case "describe:start":
                if (this.#isFileViewExpanded) {
                    this.#fileView.beginDescribe(payload.result.describe.name);
                }
                break;
            case "describe:end":
                if (this.#isFileViewExpanded) {
                    this.#fileView.endDescribe();
                }
                break;
            case "test:skip":
                if (this.#isFileViewExpanded) {
                    this.#fileView.addTest("skip", payload.result.test.name);
                }
                break;
            case "test:todo":
                if (this.#isFileViewExpanded) {
                    this.#fileView.addTest("todo", payload.result.test.name);
                }
                break;
            case "test:error":
                if (this.#isFileViewExpanded) {
                    this.#fileView.addTest("fail", payload.result.test.name);
                }
                for (const diagnostic of payload.diagnostics) {
                    this.#fileView.addMessage(diagnosticText(diagnostic));
                }
                break;
            case "test:fail":
                if (this.#isFileViewExpanded) {
                    this.#fileView.addTest("fail", payload.result.test.name);
                }
                break;
            case "test:pass":
                if (this.#isFileViewExpanded) {
                    this.#fileView.addTest("pass", payload.result.test.name);
                }
                break;
            case "expect:error":
            case "expect:fail":
                for (const diagnostic of payload.diagnostics) {
                    this.#fileView.addMessage(diagnosticText(diagnostic));
                }
                break;
        }
    }
}

class SetupReporter extends Reporter {
    handleEvent([eventName, payload]) {
        if (eventName === "store:adds") {
            this.outputService.writeMessage(addsPackageText(payload.packageVersion, payload.packagePath));
            return;
        }
        if ("diagnostics" in payload) {
            for (const diagnostic of payload.diagnostics) {
                switch (diagnostic.category) {
                    case "error":
                        this.outputService.writeError(diagnosticText(diagnostic));
                        break;
                    case "warning":
                        this.outputService.writeWarning(diagnosticText(diagnostic));
                        break;
                }
            }
        }
    }
}

class SummaryReporter extends Reporter {
    handleEvent([eventName, payload]) {
        if (eventName === "run:end") {
            this.outputService.writeMessage(summaryText({
                duration: payload.result.timing.duration,
                expectCount: payload.result.expectCount,
                fileCount: payload.result.fileCount,
                onlyMatch: payload.result.resolvedConfig.only,
                pathMatch: payload.result.resolvedConfig.pathMatch,
                skipMatch: payload.result.resolvedConfig.skip,
                targetCount: payload.result.targetCount,
                testCount: payload.result.testCount,
            }));
        }
    }
}

class WatchReporter extends Reporter {
    handleEvent([eventName, payload]) {
        switch (eventName) {
            case "run:start":
                this.outputService.clearTerminal();
                break;
            case "run:end":
                this.outputService.writeMessage(watchUsageText());
                break;
            case "watch:error":
                this.outputService.clearTerminal();
                for (const diagnostic of payload.diagnostics) {
                    this.outputService.writeError(diagnosticText(diagnostic));
                }
                this.outputService.writeMessage(waitingForFileChangesText());
                break;
        }
    }
}

class CancellationToken {
    #isCancelled = false;
    #reason;
    get isCancellationRequested() {
        return this.#isCancelled;
    }
    get reason() {
        return this.#reason;
    }
    cancel(reason) {
        if (!this.#isCancelled) {
            this.#isCancelled = true;
            this.#reason = reason;
        }
    }
    reset() {
        if (this.#isCancelled) {
            this.#isCancelled = false;
            this.#reason = undefined;
        }
    }
}

var CancellationReason;
(function (CancellationReason) {
    CancellationReason["ConfigChange"] = "configChange";
    CancellationReason["ConfigError"] = "configError";
    CancellationReason["FailFast"] = "failFast";
    CancellationReason["WatchClose"] = "watchClose";
})(CancellationReason || (CancellationReason = {}));

class Watcher {
    #onChanged;
    #onRemoved;
    #recursive;
    #targetPath;
    #watcher;
    constructor(targetPath, onChanged, onRemoved, options) {
        this.#targetPath = targetPath;
        this.#onChanged = onChanged;
        this.#onRemoved = onRemoved ?? onChanged;
        this.#recursive = options?.recursive;
    }
    close() {
        this.#watcher?.close();
    }
    watch() {
        this.#watcher = watch(this.#targetPath, { recursive: this.#recursive }, (_eventType, fileName) => {
            if (fileName != null) {
                const filePath = Path.resolve(this.#targetPath, fileName);
                if (existsSync(filePath)) {
                    this.#onChanged(filePath);
                }
                else {
                    this.#onRemoved(filePath);
                }
            }
        });
    }
}

class FileWatcher extends Watcher {
    constructor(targetPath, onChanged) {
        const onChangedFile = (filePath) => {
            if (filePath === targetPath) {
                onChanged();
            }
        };
        super(Path.dirname(targetPath), onChangedFile);
    }
}

class InputService {
    #onInput;
    #stdin = process.stdin;
    constructor(onInput) {
        this.#onInput = onInput;
        this.#stdin.setRawMode?.(true);
        this.#stdin.setEncoding("utf8");
        this.#stdin.unref();
        this.#stdin.addListener("data", this.#onInput);
    }
    close() {
        this.#stdin.removeListener("data", this.#onInput);
        this.#stdin.setRawMode?.(false);
    }
}

class SelectDiagnosticText {
    static #pathSelectOptions(resolvedConfig) {
        const text = [
            `Root path:       ${resolvedConfig.rootPath}`,
            `Test file match: ${resolvedConfig.testFileMatch.join(", ")}`,
        ];
        if (resolvedConfig.pathMatch.length > 0) {
            text.push(`Path match:      ${resolvedConfig.pathMatch.join(", ")}`);
        }
        return text;
    }
    static noTestFilesWereLeft(resolvedConfig) {
        return [
            "No test files were left to run using current configuration.",
            ...SelectDiagnosticText.#pathSelectOptions(resolvedConfig),
        ];
    }
    static noTestFilesWereSelected(resolvedConfig) {
        return [
            "No test files were selected using current configuration.",
            ...SelectDiagnosticText.#pathSelectOptions(resolvedConfig),
        ];
    }
}

class GlobPattern {
    static #reservedCharacterRegex = /[^\w\s/]/g;
    static #parse(pattern, usageTarget) {
        const segments = pattern.split("/");
        let resultPattern = "\\.";
        let optionalSegmentCount = 0;
        for (const segment of segments) {
            if (segment === ".") {
                continue;
            }
            if (segment === "**") {
                resultPattern += "(\\/(?!(node_modules)(\\/|$))[^./][^/]*)*?";
                continue;
            }
            if (usageTarget === "directories") {
                resultPattern += "(";
                optionalSegmentCount++;
            }
            resultPattern += "\\/";
            const segmentPattern = segment.replace(GlobPattern.#reservedCharacterRegex, GlobPattern.#replaceReservedCharacter);
            if (segmentPattern !== segment) {
                resultPattern += "(?!(node_modules)(\\/|$))";
            }
            resultPattern += segmentPattern;
        }
        resultPattern += ")?".repeat(optionalSegmentCount);
        return resultPattern;
    }
    static #replaceReservedCharacter(match, offset) {
        switch (match) {
            case "*":
                return offset === 0 ? "([^./][^/]*)?" : "([^/]*)?";
            case "?":
                return offset === 0 ? "[^./]" : "[^/]";
            default:
                return `\\${match}`;
        }
    }
    static toRegex(patterns, usageTarget) {
        const patternText = patterns.map((pattern) => `(${GlobPattern.#parse(pattern, usageTarget)})`).join("|");
        return new RegExp(`^(${patternText})$`);
    }
}

class SelectService {
    #includeDirectoryRegex;
    #includeFileRegex;
    #resolvedConfig;
    constructor(resolvedConfig) {
        this.#resolvedConfig = resolvedConfig;
        this.#includeDirectoryRegex = GlobPattern.toRegex(resolvedConfig.testFileMatch, "directories");
        this.#includeFileRegex = GlobPattern.toRegex(resolvedConfig.testFileMatch, "files");
    }
    #isDirectoryIncluded(directoryPath) {
        return this.#includeDirectoryRegex.test(directoryPath);
    }
    #isFileIncluded(filePath) {
        if (this.#resolvedConfig.pathMatch.length > 0 &&
            !this.#resolvedConfig.pathMatch.some((match) => filePath.toLowerCase().includes(match.toLowerCase()))) {
            return false;
        }
        return this.#includeFileRegex.test(filePath);
    }
    isTestFile(filePath) {
        return this.#isFileIncluded(Path.relative(this.#resolvedConfig.rootPath, filePath));
    }
    #onDiagnostics(diagnostic) {
        EventEmitter.dispatch(["select:error", { diagnostics: [diagnostic] }]);
    }
    async #resolveEntryMeta(entry, targetPath) {
        if (!entry.isSymbolicLink()) {
            return entry;
        }
        let entryMeta;
        try {
            entryMeta = await fs.stat([targetPath, entry.name].join("/"));
        }
        catch {
        }
        return entryMeta;
    }
    async selectFiles() {
        const testFilePaths = [];
        await this.#visitDirectory(".", testFilePaths);
        if (testFilePaths.length === 0) {
            this.#onDiagnostics(Diagnostic.error(SelectDiagnosticText.noTestFilesWereSelected(this.#resolvedConfig)));
        }
        return testFilePaths.sort();
    }
    async #visitDirectory(currentPath, testFilePaths) {
        const targetPath = Path.join(this.#resolvedConfig.rootPath, currentPath);
        try {
            const entries = await fs.readdir(targetPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryMeta = await this.#resolveEntryMeta(entry, targetPath);
                const entryPath = [currentPath, entry.name].join("/");
                if (entryMeta?.isDirectory() && this.#isDirectoryIncluded(entryPath)) {
                    await this.#visitDirectory(entryPath, testFilePaths);
                }
                else if (entryMeta?.isFile() && this.#isFileIncluded(entryPath)) {
                    testFilePaths.push([targetPath, entry.name].join("/"));
                }
            }
        }
        catch {
        }
    }
}

class Task {
    filePath;
    position;
    constructor(filePath, position) {
        this.filePath = Path.normalizeSlashes(this.#toPath(filePath));
        this.position = position;
    }
    #toPath(filePath) {
        if (typeof filePath === "string" && !filePath.startsWith("file:")) {
            return filePath;
        }
        return fileURLToPath(filePath);
    }
}

class Debounce {
    #delay;
    #onResolve;
    #resolve;
    #timeout;
    constructor(delay, onResolve) {
        this.#delay = delay;
        this.#onResolve = onResolve;
    }
    clearTimeout() {
        clearTimeout(this.#timeout);
    }
    refreshTimeout() {
        this.clearTimeout();
        this.#timeout = setTimeout(() => {
            this.#resolve?.(this.#onResolve());
        }, this.#delay);
    }
    resolveWith(value) {
        this.#resolve?.(value);
    }
    setup() {
        return new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }
}

class WatchService {
    #changedTestFiles = new Map();
    #inputService;
    #resolvedConfig;
    #selectService;
    #watchedTestFiles;
    #watchers = [];
    constructor(resolvedConfig, selectService, tasks) {
        this.#resolvedConfig = resolvedConfig;
        this.#selectService = selectService;
        this.#watchedTestFiles = new Map(tasks.map((task) => [task.filePath, task]));
    }
    #onDiagnostics(diagnostic) {
        EventEmitter.dispatch(["watch:error", { diagnostics: [diagnostic] }]);
    }
    async *watch(cancellationToken) {
        const onResolve = () => {
            const testFiles = [...this.#changedTestFiles.values()];
            this.#changedTestFiles.clear();
            return testFiles;
        };
        const debounce = new Debounce(100, onResolve);
        const onClose = (reason) => {
            debounce.clearTimeout();
            this.#inputService?.close();
            for (const watcher of this.#watchers) {
                watcher.close();
            }
            cancellationToken.cancel(reason);
            debounce.resolveWith([]);
        };
        const onInput = (chunk) => {
            switch (chunk.toLowerCase()) {
                case "\u0003":
                case "\u0004":
                case "\u001B":
                case "q":
                case "x":
                    onClose("watchClose");
                    break;
                case "\u000D":
                case "\u0020":
                case "a":
                    debounce.clearTimeout();
                    if (this.#watchedTestFiles.size > 0) {
                        debounce.resolveWith([...this.#watchedTestFiles.values()]);
                    }
                    break;
            }
        };
        this.#inputService = new InputService(onInput);
        const onChangedFile = (filePath) => {
            debounce.refreshTimeout();
            let task = this.#watchedTestFiles.get(filePath);
            if (task != null) {
                this.#changedTestFiles.set(filePath, task);
            }
            else if (this.#selectService.isTestFile(filePath)) {
                task = new Task(filePath);
                this.#changedTestFiles.set(filePath, task);
                this.#watchedTestFiles.set(filePath, task);
            }
        };
        const onRemovedFile = (filePath) => {
            this.#changedTestFiles.delete(filePath);
            this.#watchedTestFiles.delete(filePath);
            if (this.#watchedTestFiles.size === 0) {
                debounce.clearTimeout();
                this.#onDiagnostics(Diagnostic.error(SelectDiagnosticText.noTestFilesWereLeft(this.#resolvedConfig)));
            }
        };
        this.#watchers.push(new Watcher(this.#resolvedConfig.rootPath, onChangedFile, onRemovedFile, { recursive: true }));
        const onChangedConfigFile = () => {
            onClose("configChange");
        };
        this.#watchers.push(new FileWatcher(this.#resolvedConfig.configFilePath, onChangedConfigFile));
        for (const watcher of this.#watchers) {
            watcher.watch();
        }
        while (!cancellationToken.isCancellationRequested) {
            const testFiles = await debounce.setup();
            if (testFiles.length > 0) {
                yield testFiles;
            }
        }
    }
}

class TestMember {
    brand;
    #compiler;
    diagnostics = new Set();
    flags;
    members = [];
    name = "";
    node;
    parent;
    constructor(compiler, brand, node, parent, flags) {
        this.brand = brand;
        this.#compiler = compiler;
        this.node = node;
        this.parent = parent;
        this.flags = flags;
        if (node.arguments[0] != null && compiler.isStringLiteralLike(node.arguments[0])) {
            this.name = node.arguments[0].text;
        }
        if (node.arguments[1] != null &&
            compiler.isFunctionLike(node.arguments[1]) &&
            compiler.isBlock(node.arguments[1].body)) {
            const blockStart = node.arguments[1].body.getStart();
            const blockEnd = node.arguments[1].body.getEnd();
            for (const diagnostic of parent.diagnostics) {
                if (diagnostic.start != null && diagnostic.start >= blockStart && diagnostic.start <= blockEnd) {
                    this.diagnostics.add(diagnostic);
                    parent.diagnostics.delete(diagnostic);
                }
            }
        }
    }
    validate() {
        const diagnostics = [];
        const getText = (node) => `'${node.expression.getText()}()' cannot be nested within '${this.node.expression.getText()}()'.`;
        const getParentCallExpression = (node) => {
            while (!this.#compiler.isCallExpression(node.parent)) {
                node = node.parent;
            }
            return node.parent;
        };
        switch (this.brand) {
            case "describe":
                for (const member of this.members) {
                    if (member.brand === "expect") {
                        diagnostics.push(Diagnostic.error(getText(member.node), DiagnosticOrigin.fromNode(getParentCallExpression(member.node))));
                    }
                }
                break;
            case "test":
            case "expect":
                for (const member of this.members) {
                    if (member.brand !== "expect") {
                        diagnostics.push(Diagnostic.error(getText(member.node), DiagnosticOrigin.fromNode(member.node)));
                    }
                }
                break;
        }
        return diagnostics;
    }
}

class Assertion extends TestMember {
    isNot;
    matcherNode;
    modifierNode;
    notNode;
    constructor(compiler, brand, node, parent, flags, matcherNode, modifierNode, notNode) {
        super(compiler, brand, node, parent, flags);
        this.isNot = notNode != null;
        this.matcherNode = matcherNode;
        this.modifierNode = modifierNode;
        for (const diagnostic of parent.diagnostics) {
            if (diagnostic.start != null && diagnostic.start >= this.source.pos && diagnostic.start <= this.source.end) {
                this.diagnostics.add(diagnostic);
                parent.diagnostics.delete(diagnostic);
            }
        }
    }
    get matcherName() {
        return this.matcherNode.expression.name;
    }
    get source() {
        return this.node.typeArguments ?? this.node.arguments;
    }
    get target() {
        return this.matcherNode.typeArguments ?? this.matcherNode.arguments;
    }
}

class IdentifierLookup {
    #compiler;
    #identifiers;
    #moduleSpecifiers = ['"tstyche"', "'tstyche'"];
    constructor(compiler, identifiers) {
        this.#compiler = compiler;
        this.#identifiers = identifiers ?? {
            namedImports: {
                describe: undefined,
                expect: undefined,
                it: undefined,
                namespace: undefined,
                test: undefined,
            },
            namespace: undefined,
        };
    }
    handleImportDeclaration(node) {
        if (this.#moduleSpecifiers.includes(node.moduleSpecifier.getText()) &&
            node.importClause?.isTypeOnly !== true &&
            node.importClause?.namedBindings != null) {
            if (this.#compiler.isNamedImports(node.importClause.namedBindings)) {
                for (const element of node.importClause.namedBindings.elements) {
                    if (element.isTypeOnly) {
                        continue;
                    }
                    let identifierKey;
                    if (element.propertyName) {
                        identifierKey = element.propertyName.getText();
                    }
                    else {
                        identifierKey = element.name.getText();
                    }
                    if (identifierKey in this.#identifiers.namedImports) {
                        this.#identifiers.namedImports[identifierKey] = element.name.getText();
                    }
                }
            }
            if (this.#compiler.isNamespaceImport(node.importClause.namedBindings)) {
                this.#identifiers.namespace = node.importClause.namedBindings.name.getText();
            }
        }
    }
    resolveTestMemberMeta(node) {
        let flags = 0;
        let expression = node.expression;
        while (this.#compiler.isPropertyAccessExpression(expression)) {
            if (expression.expression.getText() === this.#identifiers.namespace) {
                break;
            }
            switch (expression.name.getText()) {
                case "fail":
                    flags |= 1;
                    break;
                case "only":
                    flags |= 2;
                    break;
                case "skip":
                    flags |= 4;
                    break;
                case "todo":
                    flags |= 8;
                    break;
            }
            expression = expression.expression;
        }
        let identifierName;
        if (this.#compiler.isPropertyAccessExpression(expression) &&
            expression.expression.getText() === this.#identifiers.namespace) {
            identifierName = expression.name.getText();
        }
        else {
            identifierName = Object.keys(this.#identifiers.namedImports).find((key) => this.#identifiers.namedImports[key] === expression.getText());
        }
        if (!identifierName) {
            return;
        }
        switch (identifierName) {
            case "describe":
                return { brand: "describe", flags };
            case "it":
            case "test":
                return { brand: "test", flags };
            case "expect":
                return { brand: "expect", flags };
        }
        return;
    }
}

class TestTree {
    diagnostics;
    members = [];
    sourceFile;
    constructor(diagnostics, sourceFile) {
        this.diagnostics = diagnostics;
        this.sourceFile = sourceFile;
    }
    get hasOnly() {
        function hasOnly(root) {
            return root.members.some((branch) => branch.flags & 2 || ("members" in branch && hasOnly(branch)));
        }
        return hasOnly(this);
    }
}

class CollectService {
    #compiler;
    constructor(compiler) {
        this.#compiler = compiler;
    }
    #collectTestMembers(node, identifiers, parent) {
        if (this.#compiler.isCallExpression(node)) {
            const meta = identifiers.resolveTestMemberMeta(node);
            if (meta != null && (meta.brand === "describe" || meta.brand === "test")) {
                const testMember = new TestMember(this.#compiler, meta.brand, node, parent, meta.flags);
                parent.members.push(testMember);
                this.#compiler.forEachChild(node, (node) => {
                    this.#collectTestMembers(node, identifiers, testMember);
                });
                return;
            }
            if (meta != null && meta.brand === "expect") {
                const modifierNode = this.#getChainedNode(node, "type");
                if (!modifierNode) {
                    return;
                }
                const notNode = this.#getChainedNode(modifierNode, "not");
                const matcherNode = this.#getChainedNode(notNode ?? modifierNode)?.parent;
                if (!matcherNode || !this.#isMatcherNode(matcherNode)) {
                    return;
                }
                const assertion = new Assertion(this.#compiler, meta.brand, node, parent, meta.flags, matcherNode, modifierNode, notNode);
                parent.members.push(assertion);
                this.#compiler.forEachChild(node, (node) => {
                    this.#collectTestMembers(node, identifiers, assertion);
                });
                return;
            }
        }
        if (this.#compiler.isImportDeclaration(node)) {
            identifiers.handleImportDeclaration(node);
            return;
        }
        this.#compiler.forEachChild(node, (node) => {
            this.#collectTestMembers(node, identifiers, parent);
        });
    }
    createTestTree(sourceFile, semanticDiagnostics = []) {
        const testTree = new TestTree(new Set(semanticDiagnostics), sourceFile);
        this.#collectTestMembers(sourceFile, new IdentifierLookup(this.#compiler), testTree);
        return testTree;
    }
    #getChainedNode({ parent }, name) {
        if (!this.#compiler.isPropertyAccessExpression(parent)) {
            return;
        }
        if (name != null && name !== parent.name.getText()) {
            return;
        }
        return parent;
    }
    #isMatcherNode(node) {
        return this.#compiler.isCallExpression(node) && this.#compiler.isPropertyAccessExpression(node.expression);
    }
}

var TestMemberBrand;
(function (TestMemberBrand) {
    TestMemberBrand["Describe"] = "describe";
    TestMemberBrand["Test"] = "test";
    TestMemberBrand["Expect"] = "expect";
})(TestMemberBrand || (TestMemberBrand = {}));

var TestMemberFlags;
(function (TestMemberFlags) {
    TestMemberFlags[TestMemberFlags["None"] = 0] = "None";
    TestMemberFlags[TestMemberFlags["Fail"] = 1] = "Fail";
    TestMemberFlags[TestMemberFlags["Only"] = 2] = "Only";
    TestMemberFlags[TestMemberFlags["Skip"] = 4] = "Skip";
    TestMemberFlags[TestMemberFlags["Todo"] = 8] = "Todo";
})(TestMemberFlags || (TestMemberFlags = {}));

class Version {
    static isGreaterThan(source, target) {
        return !(source === target) && Version.#satisfies(source, target);
    }
    static isSatisfiedWith(source, target) {
        return source === target || Version.#satisfies(source, target);
    }
    static isVersionTag(target) {
        return /^\d+/.test(target);
    }
    static #satisfies(source, target) {
        const sourceElements = source.split(/\.|-/);
        const targetElements = target.split(/\.|-/);
        function compare(index = 0) {
            const sourceElement = sourceElements[index];
            const targetElement = targetElements[index];
            if (sourceElement > targetElement) {
                return true;
            }
            if (sourceElement < targetElement) {
                return false;
            }
            if (index === sourceElements.length - 1 || index === targetElements.length - 1) {
                return true;
            }
            return compare(index + 1);
        }
        return compare();
    }
}

class ProjectService {
    #compiler;
    #service;
    constructor(compiler) {
        this.#compiler = compiler;
        const noop = () => undefined;
        const noopLogger = {
            close: noop,
            endGroup: noop,
            getLogFileName: noop,
            hasLevel: () => false,
            info: noop,
            loggingEnabled: () => false,
            msg: noop,
            perftrc: noop,
            startGroup: noop,
        };
        const noopWatcher = {
            close: noop,
        };
        const host = {
            ...this.#compiler.sys,
            clearImmediate,
            clearTimeout,
            setImmediate,
            setTimeout,
            watchDirectory: () => noopWatcher,
            watchFile: () => noopWatcher,
        };
        this.#service = new this.#compiler.server.ProjectService({
            allowLocalPluginLoads: true,
            cancellationToken: this.#compiler.server.nullCancellationToken,
            host,
            logger: noopLogger,
            session: undefined,
            useInferredProjectPerProjectRoot: true,
            useSingleInferredProject: false,
        });
        this.#service.setCompilerOptionsForInferredProjects(this.#getDefaultCompilerOptions());
    }
    closeFile(filePath) {
        this.#service.closeClientFile(filePath);
    }
    #getDefaultCompilerOptions() {
        const defaultCompilerOptions = {
            allowJs: true,
            checkJs: true,
            esModuleInterop: true,
            jsx: "preserve",
            module: "esnext",
            moduleResolution: "node",
            resolveJsonModule: true,
            strictFunctionTypes: true,
            strictNullChecks: true,
            target: "esnext",
        };
        if (Version.isSatisfiedWith(this.#compiler.version, "5.4")) {
            defaultCompilerOptions.module = "preserve";
        }
        if (Version.isSatisfiedWith(this.#compiler.version, "5.0")) {
            defaultCompilerOptions.allowImportingTsExtensions = true;
            defaultCompilerOptions.moduleResolution = "bundler";
        }
        return defaultCompilerOptions;
    }
    getDefaultProject(filePath) {
        return this.#service.getDefaultProjectForFile(this.#compiler.server.toNormalizedPath(filePath), true);
    }
    getLanguageService(filePath) {
        const project = this.getDefaultProject(filePath);
        return project?.getLanguageService(true);
    }
    openFile(filePath, sourceText, projectRootPath) {
        const { configFileErrors, configFileName } = this.#service.openClientFile(filePath, sourceText, undefined, projectRootPath);
        EventEmitter.dispatch([
            "project:uses",
            { compilerVersion: this.#compiler.version, projectConfigFilePath: configFileName },
        ]);
        if (configFileErrors && configFileErrors.length > 0) {
            EventEmitter.dispatch([
                "project:error",
                { diagnostics: Diagnostic.fromDiagnostics(configFileErrors, this.#compiler) },
            ]);
        }
    }
}

class ExpectDiagnosticText {
    static argumentOrTypeArgumentMustBeProvided(argumentNameText, typeArgumentNameText) {
        return `An argument for '${argumentNameText}' or type argument for '${typeArgumentNameText}' must be provided.`;
    }
    static argumentMustBe(argumentNameText, expectedText) {
        return `An argument for '${argumentNameText}' must be ${expectedText}.`;
    }
    static argumentMustBeProvided(argumentNameText) {
        return `An argument for '${argumentNameText}' must be provided.`;
    }
    static componentAcceptsProps(isTypeNode) {
        return `${isTypeNode ? "Component type" : "Component"} accepts props of the given type.`;
    }
    static componentDoesNotAcceptProps(isTypeNode) {
        return `${isTypeNode ? "Component type" : "Component"} does not accept props of the given type.`;
    }
    static matcherIsDeprecated(matcherNameText) {
        return [
            `The '.${matcherNameText}()' matcher is deprecated and will be removed in TSTyche 4.`,
            "To learn more, visit https://tstyche.org/releases/tstyche-3",
        ];
    }
    static matcherIsNotSupported(matcherNameText) {
        return `The '.${matcherNameText}()' matcher is not supported.`;
    }
    static overloadGaveTheFollowingError(index, count, signatureText) {
        return `Overload ${index} of ${count}, '${signatureText}', gave the following error.`;
    }
    static raisedTypeError(count = 1) {
        return `The raised type error${count === 1 ? "" : "s"}:`;
    }
    static typeArgumentMustBe(argumentNameText, expectedText) {
        return `A type argument for '${argumentNameText}' must be ${expectedText}.`;
    }
    static typeDidNotRaiseError(isTypeNode) {
        return `${isTypeNode ? "Type" : "Expression type"} did not raise a type error.`;
    }
    static typeDidNotRaiseMatchingError(isTypeNode) {
        return `${isTypeNode ? "Type" : "Expression type"} did not raise a matching type error.`;
    }
    static typeDoesNotHaveProperty(typeText, propertyNameText) {
        return `Type '${typeText}' does not have property '${propertyNameText}'.`;
    }
    static typeDoesMatch(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' does match type '${targetTypeText}'.`;
    }
    static typeDoesNotMatch(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' does not match type '${targetTypeText}'.`;
    }
    static typeHasProperty(typeText, propertyNameText) {
        return `Type '${typeText}' has property '${propertyNameText}'.`;
    }
    static typeIs(typeText) {
        return `Type is '${typeText}'.`;
    }
    static typeIsAssignableTo(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is assignable to type '${targetTypeText}'.`;
    }
    static typeIsAssignableWith(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is assignable with type '${targetTypeText}'.`;
    }
    static typeIsIdenticalTo(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is identical to type '${targetTypeText}'.`;
    }
    static typeIsNotAssignableTo(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is not assignable to type '${targetTypeText}'.`;
    }
    static typeIsNotAssignableWith(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is not assignable with type '${targetTypeText}'.`;
    }
    static typeIsNotCompatibleWith(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is not compatible with type '${targetTypeText}'.`;
    }
    static typeIsNotIdenticalTo(sourceTypeText, targetTypeText) {
        return `Type '${sourceTypeText}' is not identical to type '${targetTypeText}'.`;
    }
    static typeRaisedError(isTypeNode, count, targetCount) {
        let countText = "a";
        if (count > 1 || targetCount > 1) {
            countText = count > targetCount ? `${count}` : `only ${count}`;
        }
        return `${isTypeNode ? "Type" : "Expression type"} raised ${countText} type error${count === 1 ? "" : "s"}.`;
    }
    static typeRaisedMatchingError(isTypeNode) {
        return `${isTypeNode ? "Type" : "Expression type"} raised a matching type error.`;
    }
    static typeRequiresProperty(typeText, propertyNameText) {
        return `Type '${typeText}' requires property '${propertyNameText}'.`;
    }
    static typesOfPropertyAreNotCompatible(propertyNameText) {
        return `Types of property '${propertyNameText}' are not compatible.`;
    }
}

class MatchWorker {
    assertion;
    #compiler;
    #signatureCache = new Map();
    #typeCache = new Map();
    #typeChecker;
    constructor(compiler, typeChecker, assertion) {
        this.#compiler = compiler;
        this.#typeChecker = typeChecker;
        this.assertion = assertion;
    }
    checkIsAssignableTo(sourceNode, targetNode) {
        const relation = this.#typeChecker.relation.assignable;
        return this.#checkIsRelatedTo(sourceNode, targetNode, relation);
    }
    checkIsAssignableWith(sourceNode, targetNode) {
        const relation = this.#typeChecker.relation.assignable;
        return this.#checkIsRelatedTo(targetNode, sourceNode, relation);
    }
    checkIsIdenticalTo(sourceNode, targetNode) {
        const relation = this.#typeChecker.relation.identity;
        return this.#checkIsRelatedTo(sourceNode, targetNode, relation);
    }
    checkIsSubtype(sourceNode, targetNode) {
        const relation = this.#typeChecker.relation.subtype;
        return this.#checkIsRelatedTo(sourceNode, targetNode, relation);
    }
    #checkIsRelatedTo(sourceNode, targetNode, relation) {
        const sourceType = this.getType(sourceNode);
        const targetType = this.getType(targetNode);
        return this.#typeChecker.isTypeRelatedTo(sourceType, targetType, relation);
    }
    extendsObjectType(type) {
        const nonPrimitiveType = { flags: this.#compiler.TypeFlags.NonPrimitive };
        return this.#typeChecker.isTypeAssignableTo(type, nonPrimitiveType);
    }
    getParameterType(signature, index) {
        const parameter = signature.getDeclaration().parameters[index];
        if (!parameter) {
            return;
        }
        return this.#getTypeOfNode(parameter);
    }
    getSignatures(node) {
        let signatures = this.#signatureCache.get(node);
        if (!signatures) {
            const type = this.getType(node);
            signatures = type.getCallSignatures();
            if (signatures.length === 0) {
                signatures = type.getConstructSignatures();
            }
        }
        return signatures;
    }
    getTypeText(node) {
        const type = this.getType(node);
        return this.#typeChecker.typeToString(type, undefined, tsval.TypeFormatFlags.NoTruncation);
    }
    getType(node) {
        return this.#compiler.isExpression(node) ? this.#getTypeOfNode(node) : this.#getTypeOfTypeNode(node);
    }
    #getTypeOfNode(node) {
        let type = this.#typeCache.get(node);
        if (!type) {
            type = this.#typeChecker.getTypeAtLocation(node);
        }
        return type;
    }
    #getTypeOfTypeNode(node) {
        let type = this.#typeCache.get(node);
        if (!type) {
            type = this.#typeChecker.getTypeFromTypeNode(node);
        }
        return type;
    }
    isAnyOrNeverType(type) {
        return !!(type.flags & (this.#compiler.TypeFlags.Any | this.#compiler.TypeFlags.Never));
    }
    isStringOrNumberLiteralType(type) {
        return !!(type.flags & this.#compiler.TypeFlags.StringOrNumberLiteral);
    }
    isObjectType(type) {
        return !!(type.flags & this.#compiler.TypeFlags.Object);
    }
    isUnionType(type) {
        return !!(type.flags & this.#compiler.TypeFlags.Union);
    }
    isUniqueSymbolType(type) {
        return !!(type.flags & this.#compiler.TypeFlags.UniqueESSymbol);
    }
    resolveDiagnosticOrigin(symbol, enclosingNode) {
        if (symbol.valueDeclaration != null &&
            (this.#compiler.isPropertySignature(symbol.valueDeclaration) ||
                this.#compiler.isPropertyAssignment(symbol.valueDeclaration) ||
                this.#compiler.isShorthandPropertyAssignment(symbol.valueDeclaration)) &&
            symbol.valueDeclaration.getStart() >= enclosingNode.getStart() &&
            symbol.valueDeclaration.getEnd() <= enclosingNode.getEnd()) {
            return DiagnosticOrigin.fromNode(symbol.valueDeclaration.name, this.assertion);
        }
        return DiagnosticOrigin.fromNode(enclosingNode, this.assertion);
    }
}

class PrimitiveTypeMatcher {
    #targetTypeFlag;
    constructor(targetTypeFlag) {
        this.#targetTypeFlag = targetTypeFlag;
    }
    #explain(matchWorker, sourceNode) {
        const sourceTypeText = matchWorker.getTypeText(sourceNode);
        const origin = DiagnosticOrigin.fromAssertion(matchWorker.assertion);
        return [Diagnostic.error(ExpectDiagnosticText.typeIs(sourceTypeText), origin)];
    }
    match(matchWorker, sourceNode) {
        const sourceType = matchWorker.getType(sourceNode);
        const isMatch = !!(sourceType.flags & this.#targetTypeFlag);
        return {
            explain: () => this.#explain(matchWorker, sourceNode),
            isMatch,
        };
    }
}

class ToAcceptProps {
    #compiler;
    #typeChecker;
    constructor(compiler, typeChecker) {
        this.#compiler = compiler;
        this.#typeChecker = typeChecker;
    }
    #explain(matchWorker, sourceNode, targetNode) {
        const signatures = matchWorker.getSignatures(sourceNode);
        return signatures.reduce((accumulator, signature, index) => {
            let diagnostic;
            const introText = matchWorker.assertion.isNot
                ? ExpectDiagnosticText.componentAcceptsProps(this.#compiler.isTypeNode(sourceNode))
                : ExpectDiagnosticText.componentDoesNotAcceptProps(this.#compiler.isTypeNode(sourceNode));
            const origin = DiagnosticOrigin.fromNode(targetNode, matchWorker.assertion);
            if (signatures.length > 1) {
                const signatureText = this.#typeChecker.signatureToString(signature, sourceNode);
                const overloadText = ExpectDiagnosticText.overloadGaveTheFollowingError(index + 1, signatures.length, signatureText);
                diagnostic = Diagnostic.error([introText, overloadText], origin);
            }
            else {
                diagnostic = Diagnostic.error([introText], origin);
            }
            const { diagnostics, isMatch } = this.#explainProperties(matchWorker, signature, targetNode, diagnostic);
            if (matchWorker.assertion.isNot ? isMatch : !isMatch) {
                accumulator.push(...diagnostics);
            }
            return accumulator;
        }, []);
    }
    #isOptionalProperty(symbol) {
        return symbol.declarations?.every((declaration) => this.#compiler.isPropertySignature(declaration) && declaration.questionToken != null);
    }
    #checkProperties(matchWorker, sourceType, targetType) {
        const check = (sourceType, targetType) => {
            for (const targetProperty of targetType.getProperties()) {
                const targetPropertyName = targetProperty.getName();
                const sourceProperty = sourceType?.getProperty(targetPropertyName);
                if (!sourceProperty) {
                    return false;
                }
                if (this.#isOptionalProperty(targetProperty) && !this.#isOptionalProperty(sourceProperty)) {
                    return false;
                }
                const targetPropertyType = this.#typeChecker.getTypeOfSymbol(targetProperty);
                const sourcePropertyType = this.#typeChecker.getTypeOfSymbol(sourceProperty);
                if (!this.#typeChecker.isTypeAssignableTo(targetPropertyType, sourcePropertyType)) {
                    return false;
                }
            }
            if (sourceType != null) {
                const sourceProperties = sourceType.getProperties();
                for (const sourceProperty of sourceProperties) {
                    const targetProperty = targetType.getProperty(sourceProperty.getName());
                    if (!targetProperty && !this.#isOptionalProperty(sourceProperty)) {
                        return false;
                    }
                }
            }
            return true;
        };
        if (sourceType != null && matchWorker.isUnionType(sourceType)) {
            return sourceType.types.some((sourceType) => check(sourceType, targetType));
        }
        return check(sourceType, targetType);
    }
    #explainProperties(matchWorker, signature, targetNode, diagnostic) {
        const sourceType = matchWorker.getParameterType(signature, 0);
        const sourceTypeText = sourceType != null ? this.#typeChecker.typeToString(sourceType) : "{}";
        const targetType = matchWorker.getType(targetNode);
        const targetTypeText = this.#typeChecker.typeToString(targetType);
        const explain = (sourceType, targetType, diagnostic) => {
            const sourceTypeText = sourceType != null ? this.#typeChecker.typeToString(sourceType) : "{}";
            const diagnostics = [];
            for (const targetProperty of targetType.getProperties()) {
                const targetPropertyName = targetProperty.getName();
                const sourceProperty = sourceType?.getProperty(targetPropertyName);
                if (!sourceProperty) {
                    const text = [
                        ExpectDiagnosticText.typeIsNotCompatibleWith(sourceTypeText, targetTypeText),
                        ExpectDiagnosticText.typeDoesNotHaveProperty(sourceTypeText, targetPropertyName),
                    ];
                    const origin = matchWorker.resolveDiagnosticOrigin(targetProperty, targetNode);
                    diagnostics.push(diagnostic.extendWith(text, origin));
                    continue;
                }
                if (this.#isOptionalProperty(targetProperty) && !this.#isOptionalProperty(sourceProperty)) {
                    const text = [
                        ExpectDiagnosticText.typeIsNotAssignableWith(sourceTypeText, targetTypeText),
                        ExpectDiagnosticText.typeRequiresProperty(sourceTypeText, targetPropertyName),
                    ];
                    const origin = matchWorker.resolveDiagnosticOrigin(targetProperty, targetNode);
                    diagnostics.push(diagnostic.extendWith(text, origin));
                    continue;
                }
                const targetPropertyType = this.#typeChecker.getTypeOfSymbol(targetProperty);
                const sourcePropertyType = this.#typeChecker.getTypeOfSymbol(sourceProperty);
                if (!this.#typeChecker.isTypeAssignableTo(targetPropertyType, sourcePropertyType)) {
                    const targetPropertyTypeText = this.#typeChecker.typeToString(targetPropertyType);
                    const sourcePropertyTypeText = this.#typeChecker.typeToString(sourcePropertyType);
                    const text = [
                        ExpectDiagnosticText.typeIsNotAssignableWith(sourceTypeText, targetTypeText),
                        ExpectDiagnosticText.typesOfPropertyAreNotCompatible(targetPropertyName),
                        ExpectDiagnosticText.typeIsNotAssignableWith(sourcePropertyTypeText, targetPropertyTypeText),
                    ];
                    const origin = matchWorker.resolveDiagnosticOrigin(targetProperty, targetNode);
                    diagnostics.push(diagnostic.extendWith(text, origin));
                }
            }
            if (sourceType != null) {
                for (const sourceProperty of sourceType.getProperties()) {
                    const sourcePropertyName = sourceProperty.getName();
                    const targetProperty = targetType.getProperty(sourcePropertyName);
                    if (!targetProperty && !this.#isOptionalProperty(sourceProperty)) {
                        const text = [
                            ExpectDiagnosticText.typeIsNotAssignableWith(sourceTypeText, targetTypeText),
                            ExpectDiagnosticText.typeRequiresProperty(sourceTypeText, sourcePropertyName),
                        ];
                        diagnostics.push(diagnostic.extendWith(text));
                    }
                }
            }
            if (diagnostics.length === 0) {
                const text = ExpectDiagnosticText.typeIsAssignableWith(sourceTypeText, targetTypeText);
                diagnostics.push(diagnostic.extendWith(text));
                return { diagnostics, isMatch: true };
            }
            return { diagnostics, isMatch: false };
        };
        if (sourceType != null && matchWorker.isUnionType(sourceType)) {
            let accumulator = [];
            const isMatch = sourceType.types.some((sourceType) => {
                const text = matchWorker.assertion.isNot
                    ? ExpectDiagnosticText.typeIsAssignableWith(sourceTypeText, targetTypeText)
                    : ExpectDiagnosticText.typeIsNotAssignableWith(sourceTypeText, targetTypeText);
                const { diagnostics, isMatch } = explain(sourceType, targetType, diagnostic.extendWith(text));
                if (isMatch) {
                    accumulator = diagnostics;
                }
                else {
                    accumulator.push(...diagnostics);
                }
                return isMatch;
            });
            return { diagnostics: accumulator, isMatch };
        }
        return explain(sourceType, targetType, diagnostic);
    }
    match(matchWorker, sourceNode, targetNode, onDiagnostics) {
        const diagnostics = [];
        const signatures = matchWorker.getSignatures(sourceNode);
        if (signatures.length === 0) {
            const expectedText = "of a function or class type";
            const text = this.#compiler.isTypeNode(sourceNode)
                ? ExpectDiagnosticText.typeArgumentMustBe("Source", expectedText)
                : ExpectDiagnosticText.argumentMustBe("source", expectedText);
            const origin = DiagnosticOrigin.fromNode(sourceNode);
            diagnostics.push(Diagnostic.error(text, origin));
        }
        const targetType = matchWorker.getType(targetNode);
        if (!matchWorker.isObjectType(targetType)) {
            const expectedText = "of an object type";
            const text = this.#compiler.isTypeNode(targetNode)
                ? ExpectDiagnosticText.typeArgumentMustBe("Target", expectedText)
                : ExpectDiagnosticText.argumentMustBe("target", expectedText);
            const origin = DiagnosticOrigin.fromNode(targetNode);
            diagnostics.push(Diagnostic.error(text, origin));
        }
        if (diagnostics.length > 0) {
            onDiagnostics(diagnostics);
            return;
        }
        const isMatch = signatures.some((signature) => {
            const sourceType = matchWorker.getParameterType(signature, 0);
            return this.#checkProperties(matchWorker, sourceType, targetType);
        });
        return {
            explain: () => this.#explain(matchWorker, sourceNode, targetNode),
            isMatch,
        };
    }
}

class RelationMatcherBase {
    explain(matchWorker, sourceNode, targetNode) {
        const sourceTypeText = matchWorker.getTypeText(sourceNode);
        const targetTypeText = matchWorker.getTypeText(targetNode);
        const text = matchWorker.assertion.isNot
            ? this.explainText(sourceTypeText, targetTypeText)
            : this.explainNotText(sourceTypeText, targetTypeText);
        const origin = DiagnosticOrigin.fromNode(targetNode, matchWorker.assertion);
        return [Diagnostic.error(text, origin)];
    }
}

class ToBe extends RelationMatcherBase {
    explainText = ExpectDiagnosticText.typeIsIdenticalTo;
    explainNotText = ExpectDiagnosticText.typeIsNotIdenticalTo;
    match(matchWorker, sourceNode, targetNode) {
        return {
            explain: () => this.explain(matchWorker, sourceNode, targetNode),
            isMatch: matchWorker.checkIsIdenticalTo(sourceNode, targetNode),
        };
    }
}

class ToBeAssignableTo extends RelationMatcherBase {
    explainText = ExpectDiagnosticText.typeIsAssignableTo;
    explainNotText = ExpectDiagnosticText.typeIsNotAssignableTo;
    match(matchWorker, sourceNode, targetNode) {
        return {
            explain: () => this.explain(matchWorker, sourceNode, targetNode),
            isMatch: matchWorker.checkIsAssignableTo(sourceNode, targetNode),
        };
    }
}

class ToBeAssignableWith extends RelationMatcherBase {
    explainText = ExpectDiagnosticText.typeIsAssignableWith;
    explainNotText = ExpectDiagnosticText.typeIsNotAssignableWith;
    match(matchWorker, sourceNode, targetNode) {
        return {
            explain: () => this.explain(matchWorker, sourceNode, targetNode),
            isMatch: matchWorker.checkIsAssignableWith(sourceNode, targetNode),
        };
    }
}

class ToHaveProperty {
    #compiler;
    constructor(compiler) {
        this.#compiler = compiler;
    }
    #explain(matchWorker, sourceNode, targetNode) {
        const sourceTypeText = matchWorker.getTypeText(sourceNode);
        const targetType = matchWorker.getType(targetNode);
        let propertyNameText;
        if (matchWorker.isStringOrNumberLiteralType(targetType)) {
            propertyNameText = targetType.value.toString();
        }
        else {
            propertyNameText = `[${this.#compiler.unescapeLeadingUnderscores(targetType.symbol.escapedName)}]`;
        }
        const origin = DiagnosticOrigin.fromNode(targetNode, matchWorker.assertion);
        return matchWorker.assertion.isNot
            ? [Diagnostic.error(ExpectDiagnosticText.typeHasProperty(sourceTypeText, propertyNameText), origin)]
            : [Diagnostic.error(ExpectDiagnosticText.typeDoesNotHaveProperty(sourceTypeText, propertyNameText), origin)];
    }
    match(matchWorker, sourceNode, targetNode, onDiagnostics) {
        const diagnostics = [];
        const sourceType = matchWorker.getType(sourceNode);
        if (matchWorker.isAnyOrNeverType(sourceType) || !matchWorker.extendsObjectType(sourceType)) {
            const expectedText = "of an object type";
            const text = this.#compiler.isTypeNode(sourceNode)
                ? ExpectDiagnosticText.typeArgumentMustBe("Source", expectedText)
                : ExpectDiagnosticText.argumentMustBe("source", expectedText);
            const origin = DiagnosticOrigin.fromNode(sourceNode);
            diagnostics.push(Diagnostic.error(text, origin));
        }
        const targetType = matchWorker.getType(targetNode);
        let propertyNameText;
        if (matchWorker.isStringOrNumberLiteralType(targetType)) {
            propertyNameText = targetType.value.toString();
        }
        else if (matchWorker.isUniqueSymbolType(targetType)) {
            propertyNameText = this.#compiler.unescapeLeadingUnderscores(targetType.escapedName);
        }
        else {
            const expectedText = "of type 'string | number | symbol'";
            const text = ExpectDiagnosticText.argumentMustBe("key", expectedText);
            const origin = DiagnosticOrigin.fromNode(targetNode);
            diagnostics.push(Diagnostic.error(text, origin));
        }
        if (diagnostics.length > 0) {
            onDiagnostics(diagnostics);
            return;
        }
        const isMatch = sourceType.getProperties().some((property) => {
            return this.#compiler.unescapeLeadingUnderscores(property.escapedName) === propertyNameText;
        });
        return {
            explain: () => this.#explain(matchWorker, sourceNode, targetNode),
            isMatch,
        };
    }
}

class ToMatch extends RelationMatcherBase {
    explainText = ExpectDiagnosticText.typeDoesMatch;
    explainNotText = ExpectDiagnosticText.typeDoesNotMatch;
    match(matchWorker, sourceNode, targetNode) {
        return {
            explain: () => this.explain(matchWorker, sourceNode, targetNode),
            isMatch: matchWorker.checkIsSubtype(sourceNode, targetNode),
        };
    }
}

class ToRaiseError {
    #compiler;
    constructor(compiler) {
        this.#compiler = compiler;
    }
    #explain(matchWorker, sourceNode, targetNodes) {
        const isTypeNode = this.#compiler.isTypeNode(sourceNode);
        const origin = DiagnosticOrigin.fromAssertion(matchWorker.assertion);
        if (matchWorker.assertion.diagnostics.size === 0) {
            const text = ExpectDiagnosticText.typeDidNotRaiseError(isTypeNode);
            return [Diagnostic.error(text, origin)];
        }
        if (matchWorker.assertion.diagnostics.size !== targetNodes.length) {
            const count = matchWorker.assertion.diagnostics.size;
            const text = ExpectDiagnosticText.typeRaisedError(isTypeNode, count, targetNodes.length);
            const related = [
                Diagnostic.error(ExpectDiagnosticText.raisedTypeError(count)),
                ...Diagnostic.fromDiagnostics([...matchWorker.assertion.diagnostics], this.#compiler),
            ];
            return [Diagnostic.error(text, origin).add({ related })];
        }
        return [...matchWorker.assertion.diagnostics].reduce((accumulator, diagnostic, index) => {
            const targetNode = targetNodes[index];
            const isMatch = this.#matchExpectedError(diagnostic, targetNode);
            if (matchWorker.assertion.isNot ? isMatch : !isMatch) {
                const text = matchWorker.assertion.isNot
                    ? ExpectDiagnosticText.typeRaisedMatchingError(isTypeNode)
                    : ExpectDiagnosticText.typeDidNotRaiseMatchingError(isTypeNode);
                const origin = DiagnosticOrigin.fromNode(targetNode, matchWorker.assertion);
                const related = [
                    Diagnostic.error(ExpectDiagnosticText.raisedTypeError()),
                    ...Diagnostic.fromDiagnostics([diagnostic], this.#compiler),
                ];
                accumulator.push(Diagnostic.error(text, origin).add({ related }));
            }
            return accumulator;
        }, []);
    }
    match(matchWorker, sourceNode, targetNodes, onDiagnostics) {
        const diagnostics = [];
        for (const targetNode of targetNodes) {
            if (!(this.#compiler.isStringLiteralLike(targetNode) || this.#compiler.isNumericLiteral(targetNode))) {
                const expectedText = "a string or number literal";
                const text = ExpectDiagnosticText.argumentMustBe("target", expectedText);
                const origin = DiagnosticOrigin.fromNode(targetNode);
                diagnostics.push(Diagnostic.error(text, origin));
            }
        }
        if (diagnostics.length > 0) {
            onDiagnostics(diagnostics);
            return;
        }
        let isMatch;
        if (targetNodes.length === 0) {
            isMatch = matchWorker.assertion.diagnostics.size > 0;
        }
        else {
            isMatch =
                matchWorker.assertion.diagnostics.size === targetNodes.length &&
                    [...matchWorker.assertion.diagnostics].every((diagnostic, index) => this.#matchExpectedError(diagnostic, targetNodes[index]));
        }
        return {
            explain: () => this.#explain(matchWorker, sourceNode, targetNodes),
            isMatch,
        };
    }
    #matchExpectedError(diagnostic, targetNode) {
        if (this.#compiler.isStringLiteralLike(targetNode)) {
            return this.#compiler.flattenDiagnosticMessageText(diagnostic.messageText, " ", 0).includes(targetNode.text);
        }
        return Number.parseInt(targetNode.text) === diagnostic.code;
    }
}

class ExpectService {
    #compiler;
    #typeChecker;
    toAcceptProps;
    toBe;
    toBeAny;
    toBeAssignableTo;
    toBeAssignableWith;
    toBeBigInt;
    toBeBoolean;
    toBeNever;
    toBeNull;
    toBeNumber;
    toBeString;
    toBeSymbol;
    toBeUndefined;
    toBeUniqueSymbol;
    toBeUnknown;
    toBeVoid;
    toHaveProperty;
    toMatch;
    toRaiseError;
    constructor(compiler, typeChecker) {
        this.#compiler = compiler;
        this.#typeChecker = typeChecker;
        this.toAcceptProps = new ToAcceptProps(compiler, typeChecker);
        this.toBe = new ToBe();
        this.toBeAny = new PrimitiveTypeMatcher(compiler.TypeFlags.Any);
        this.toBeAssignableTo = new ToBeAssignableTo();
        this.toBeAssignableWith = new ToBeAssignableWith();
        this.toBeBigInt = new PrimitiveTypeMatcher(compiler.TypeFlags.BigInt);
        this.toBeBoolean = new PrimitiveTypeMatcher(compiler.TypeFlags.Boolean);
        this.toBeNever = new PrimitiveTypeMatcher(compiler.TypeFlags.Never);
        this.toBeNull = new PrimitiveTypeMatcher(compiler.TypeFlags.Null);
        this.toBeNumber = new PrimitiveTypeMatcher(compiler.TypeFlags.Number);
        this.toBeString = new PrimitiveTypeMatcher(compiler.TypeFlags.String);
        this.toBeSymbol = new PrimitiveTypeMatcher(compiler.TypeFlags.ESSymbol);
        this.toBeUndefined = new PrimitiveTypeMatcher(compiler.TypeFlags.Undefined);
        this.toBeUniqueSymbol = new PrimitiveTypeMatcher(compiler.TypeFlags.UniqueESSymbol);
        this.toBeUnknown = new PrimitiveTypeMatcher(compiler.TypeFlags.Unknown);
        this.toBeVoid = new PrimitiveTypeMatcher(compiler.TypeFlags.Void);
        this.toHaveProperty = new ToHaveProperty(compiler);
        this.toMatch = new ToMatch();
        this.toRaiseError = new ToRaiseError(compiler);
    }
    match(assertion, onDiagnostics) {
        const matcherNameText = assertion.matcherName.getText();
        if (matcherNameText === "toMatch") {
            const text = ExpectDiagnosticText.matcherIsDeprecated(matcherNameText);
            const origin = DiagnosticOrigin.fromNode(assertion.matcherName);
            EventEmitter.dispatch(["deprecation:info", { diagnostics: [Diagnostic.warning(text, origin)] }]);
        }
        if (!assertion.source[0]) {
            this.#onSourceArgumentOrTypeArgumentMustBeProvided(assertion, onDiagnostics);
            return;
        }
        const matchWorker = new MatchWorker(this.#compiler, this.#typeChecker, assertion);
        switch (matcherNameText) {
            case "toAcceptProps":
            case "toBe":
            case "toBeAssignableTo":
            case "toBeAssignableWith":
            case "toMatch":
                if (!assertion.target[0]) {
                    this.#onTargetArgumentOrTypeArgumentMustBeProvided(assertion, onDiagnostics);
                    return;
                }
                return this[matcherNameText].match(matchWorker, assertion.source[0], assertion.target[0], onDiagnostics);
            case "toBeAny":
            case "toBeBigInt":
            case "toBeBoolean":
            case "toBeNever":
            case "toBeNull":
            case "toBeNumber":
            case "toBeString":
            case "toBeSymbol":
            case "toBeUndefined":
            case "toBeUniqueSymbol":
            case "toBeUnknown":
            case "toBeVoid":
                return this[matcherNameText].match(matchWorker, assertion.source[0]);
            case "toHaveProperty":
                if (!assertion.target[0]) {
                    this.#onTargetArgumentMustBeProvided("key", assertion, onDiagnostics);
                    return;
                }
                return this.toHaveProperty.match(matchWorker, assertion.source[0], assertion.target[0], onDiagnostics);
            case "toRaiseError":
                return this.toRaiseError.match(matchWorker, assertion.source[0], [...assertion.target], onDiagnostics);
            default:
                this.#onMatcherIsNotSupported(matcherNameText, assertion, onDiagnostics);
        }
        return;
    }
    #onMatcherIsNotSupported(matcherNameText, assertion, onDiagnostics) {
        const text = ExpectDiagnosticText.matcherIsNotSupported(matcherNameText);
        const origin = DiagnosticOrigin.fromNode(assertion.matcherName);
        onDiagnostics(Diagnostic.error(text, origin));
    }
    #onSourceArgumentOrTypeArgumentMustBeProvided(assertion, onDiagnostics) {
        const text = ExpectDiagnosticText.argumentOrTypeArgumentMustBeProvided("source", "Source");
        const origin = DiagnosticOrigin.fromNode(assertion.node.expression);
        onDiagnostics(Diagnostic.error(text, origin));
    }
    #onTargetArgumentMustBeProvided(argumentNameText, assertion, onDiagnostics) {
        const text = ExpectDiagnosticText.argumentMustBeProvided(argumentNameText);
        const origin = DiagnosticOrigin.fromNode(assertion.matcherName);
        onDiagnostics(Diagnostic.error(text, origin));
    }
    #onTargetArgumentOrTypeArgumentMustBeProvided(assertion, onDiagnostics) {
        const text = ExpectDiagnosticText.argumentOrTypeArgumentMustBeProvided("target", "Target");
        const origin = DiagnosticOrigin.fromNode(assertion.matcherName);
        onDiagnostics(Diagnostic.error(text, origin));
    }
}

class TestTreeWorker {
    #compiler;
    #cancellationToken;
    #expectService;
    #hasOnly;
    #position;
    #resolvedConfig;
    #taskResult;
    constructor(resolvedConfig, compiler, typeChecker, options) {
        this.#resolvedConfig = resolvedConfig;
        this.#compiler = compiler;
        this.#cancellationToken = options.cancellationToken;
        this.#hasOnly = options.hasOnly || resolvedConfig.only != null || options.position != null;
        this.#position = options.position;
        this.#taskResult = options.taskResult;
        this.#expectService = new ExpectService(compiler, typeChecker);
    }
    #resolveRunMode(mode, member) {
        if (member.flags & 1) {
            mode |= 1;
        }
        if (member.flags & 2 ||
            (this.#resolvedConfig.only != null && member.name.toLowerCase().includes(this.#resolvedConfig.only.toLowerCase()))) {
            mode |= 2;
        }
        if (member.flags & 4 ||
            (this.#resolvedConfig.skip != null && member.name.toLowerCase().includes(this.#resolvedConfig.skip.toLowerCase()))) {
            mode |= 4;
        }
        if (member.flags & 8) {
            mode |= 8;
        }
        if (this.#position != null && member.node.getStart() === this.#position) {
            mode |= 2;
            mode &= ~4;
        }
        return mode;
    }
    visit(members, runMode, parentResult) {
        for (const member of members) {
            if (this.#cancellationToken?.isCancellationRequested === true) {
                break;
            }
            const validationError = member.validate();
            if (validationError.length > 0) {
                EventEmitter.dispatch(["task:error", { diagnostics: validationError, result: this.#taskResult }]);
                break;
            }
            switch (member.brand) {
                case "describe":
                    this.#visitDescribe(member, runMode, parentResult);
                    break;
                case "test":
                    this.#visitTest(member, runMode, parentResult);
                    break;
                case "expect":
                    this.#visitAssertion(member, runMode, parentResult);
                    break;
            }
        }
    }
    #visitAssertion(assertion, runMode, parentResult) {
        this.visit(assertion.members, runMode, parentResult);
        const expectResult = new ExpectResult(assertion, parentResult);
        EventEmitter.dispatch(["expect:start", { result: expectResult }]);
        runMode = this.#resolveRunMode(runMode, assertion);
        if (runMode & 4 || (this.#hasOnly && !(runMode & 2))) {
            EventEmitter.dispatch(["expect:skip", { result: expectResult }]);
            return;
        }
        const onExpectDiagnostics = (diagnostics) => {
            EventEmitter.dispatch([
                "expect:error",
                { diagnostics: Array.isArray(diagnostics) ? diagnostics : [diagnostics], result: expectResult },
            ]);
        };
        if (assertion.diagnostics.size > 0 && assertion.matcherName.getText() !== "toRaiseError") {
            onExpectDiagnostics(Diagnostic.fromDiagnostics([...assertion.diagnostics], this.#compiler));
            return;
        }
        const matchResult = this.#expectService.match(assertion, onExpectDiagnostics);
        if (!matchResult) {
            return;
        }
        if (assertion.isNot ? !matchResult.isMatch : matchResult.isMatch) {
            if (runMode & 1) {
                const text = ["The assertion was supposed to fail, but it passed.", "Consider removing the '.fail' flag."];
                const origin = DiagnosticOrigin.fromNode(assertion.node.expression.name);
                onExpectDiagnostics(Diagnostic.error(text, origin));
            }
            else {
                EventEmitter.dispatch(["expect:pass", { result: expectResult }]);
            }
        }
        else if (runMode & 1) {
            EventEmitter.dispatch(["expect:pass", { result: expectResult }]);
        }
        else {
            EventEmitter.dispatch(["expect:fail", { diagnostics: matchResult.explain(), result: expectResult }]);
        }
    }
    #visitDescribe(describe, runMode, parentResult) {
        const describeResult = new DescribeResult(describe, parentResult);
        EventEmitter.dispatch(["describe:start", { result: describeResult }]);
        runMode = this.#resolveRunMode(runMode, describe);
        if (!(runMode & 4 || (this.#hasOnly && !(runMode & 2)) || runMode & 8) &&
            describe.diagnostics.size > 0) {
            EventEmitter.dispatch([
                "task:error",
                {
                    diagnostics: Diagnostic.fromDiagnostics([...describe.diagnostics], this.#compiler),
                    result: this.#taskResult,
                },
            ]);
        }
        else {
            this.visit(describe.members, runMode, describeResult);
        }
        EventEmitter.dispatch(["describe:end", { result: describeResult }]);
    }
    #visitTest(test, runMode, parentResult) {
        const testResult = new TestResult(test, parentResult);
        EventEmitter.dispatch(["test:start", { result: testResult }]);
        runMode = this.#resolveRunMode(runMode, test);
        if (runMode & 8) {
            EventEmitter.dispatch(["test:todo", { result: testResult }]);
            return;
        }
        if (!(runMode & 4 || (this.#hasOnly && !(runMode & 2))) && test.diagnostics.size > 0) {
            EventEmitter.dispatch([
                "test:error",
                {
                    diagnostics: Diagnostic.fromDiagnostics([...test.diagnostics], this.#compiler),
                    result: testResult,
                },
            ]);
            return;
        }
        this.visit(test.members, runMode, testResult);
        if (runMode & 4 || (this.#hasOnly && !(runMode & 2))) {
            EventEmitter.dispatch(["test:skip", { result: testResult }]);
            return;
        }
        if (testResult.expectCount.failed > 0) {
            EventEmitter.dispatch(["test:fail", { result: testResult }]);
        }
        else {
            EventEmitter.dispatch(["test:pass", { result: testResult }]);
        }
    }
}

class TaskRunner {
    #compiler;
    #collectService;
    #resolvedConfig;
    #projectService;
    constructor(resolvedConfig, compiler) {
        this.#resolvedConfig = resolvedConfig;
        this.#compiler = compiler;
        this.#collectService = new CollectService(compiler);
        this.#projectService = new ProjectService(compiler);
    }
    run(task, cancellationToken) {
        if (cancellationToken?.isCancellationRequested === true) {
            return;
        }
        this.#projectService.openFile(task.filePath, undefined, this.#resolvedConfig.rootPath);
        const taskResult = new TaskResult(task);
        EventEmitter.dispatch(["task:start", { result: taskResult }]);
        this.#run(task, taskResult, cancellationToken);
        EventEmitter.dispatch(["task:end", { result: taskResult }]);
        this.#projectService.closeFile(task.filePath);
    }
    #run(task, taskResult, cancellationToken) {
        const languageService = this.#projectService.getLanguageService(task.filePath);
        if (!languageService) {
            return;
        }
        const syntacticDiagnostics = languageService.getSyntacticDiagnostics(task.filePath);
        if (syntacticDiagnostics.length > 0) {
            EventEmitter.dispatch([
                "task:error",
                { diagnostics: Diagnostic.fromDiagnostics(syntacticDiagnostics, this.#compiler), result: taskResult },
            ]);
            return;
        }
        const semanticDiagnostics = languageService.getSemanticDiagnostics(task.filePath);
        const program = languageService.getProgram();
        if (!program) {
            return;
        }
        const sourceFile = program.getSourceFile(task.filePath);
        if (!sourceFile) {
            return;
        }
        const testTree = this.#collectService.createTestTree(sourceFile, semanticDiagnostics);
        if (testTree.diagnostics.size > 0) {
            EventEmitter.dispatch([
                "task:error",
                { diagnostics: Diagnostic.fromDiagnostics([...testTree.diagnostics], this.#compiler), result: taskResult },
            ]);
            return;
        }
        const typeChecker = program.getTypeChecker();
        const testTreeWorker = new TestTreeWorker(this.#resolvedConfig, this.#compiler, typeChecker, {
            cancellationToken,
            taskResult,
            hasOnly: testTree.hasOnly,
            position: task.position,
        });
        testTreeWorker.visit(testTree.members, 0, undefined);
    }
}

class Runner {
    #eventEmitter = new EventEmitter();
    #resolvedConfig;
    #selectService;
    #storeService;
    constructor(resolvedConfig, selectService, storeService) {
        this.#resolvedConfig = resolvedConfig;
        this.#selectService = selectService;
        this.#storeService = storeService;
        this.#eventEmitter.addHandler(new ResultHandler());
    }
    close() {
        this.#eventEmitter.removeHandlers();
    }
    async run(tasks, cancellationToken = new CancellationToken()) {
        let cancellationHandler;
        if (this.#resolvedConfig.failFast) {
            cancellationHandler = new CancellationHandler(cancellationToken, "failFast");
            this.#eventEmitter.addHandler(cancellationHandler);
        }
        if (this.#resolvedConfig.watch === true) {
            await this.#run(tasks, cancellationToken);
            await this.#watch(tasks, cancellationToken);
        }
        else {
            await this.#run(tasks, cancellationToken);
        }
        if (cancellationHandler != null) {
            this.#eventEmitter.removeHandler(cancellationHandler);
        }
    }
    async #run(tasks, cancellationToken) {
        const result = new Result(this.#resolvedConfig, tasks);
        EventEmitter.dispatch(["run:start", { result }]);
        for (const versionTag of this.#resolvedConfig.target) {
            const targetResult = new TargetResult(versionTag, tasks);
            EventEmitter.dispatch(["target:start", { result: targetResult }]);
            const compiler = await this.#storeService.load(versionTag);
            if (compiler) {
                const taskRunner = new TaskRunner(this.#resolvedConfig, compiler);
                for (const task of tasks) {
                    taskRunner.run(task, cancellationToken);
                }
            }
            EventEmitter.dispatch(["target:end", { result: targetResult }]);
        }
        EventEmitter.dispatch(["run:end", { result }]);
        if (cancellationToken.reason === "failFast") {
            cancellationToken.reset();
        }
    }
    async #watch(testFiles, cancellationToken) {
        const watchService = new WatchService(this.#resolvedConfig, this.#selectService, testFiles);
        for await (const testFiles of watchService.watch(cancellationToken)) {
            await this.#run(testFiles, cancellationToken);
        }
    }
}

class TSTyche {
    #eventEmitter = new EventEmitter();
    #outputService;
    #resolvedConfig;
    #runner;
    #selectService;
    #storeService;
    static version = "3.0.0-beta.2";
    constructor(resolvedConfig, outputService, selectService, storeService) {
        this.#resolvedConfig = resolvedConfig;
        this.#outputService = outputService;
        this.#selectService = selectService;
        this.#storeService = storeService;
        this.#runner = new Runner(this.#resolvedConfig, this.#selectService, this.#storeService);
    }
    close() {
        this.#runner.close();
    }
    async run(testFiles, cancellationToken = new CancellationToken()) {
        this.#eventEmitter.addHandler(new RunReporter(this.#resolvedConfig, this.#outputService));
        if (this.#resolvedConfig.watch === true) {
            this.#eventEmitter.addHandler(new WatchReporter(this.#outputService));
        }
        else {
            this.#eventEmitter.addHandler(new SummaryReporter(this.#outputService));
        }
        await this.#runner.run(testFiles.map((testFile) => new Task(testFile)), cancellationToken);
        this.#eventEmitter.removeHandlers();
    }
}

class StoreDiagnosticText {
    static cannotAddTypeScriptPackage(tag) {
        return `Cannot add the 'typescript' package for the '${tag}' tag.`;
    }
    static failedToFetchMetadata(registry) {
        return `Failed to fetch metadata of the 'typescript' package from '${registry}'.`;
    }
    static failedToInstalTypeScript(version) {
        return `Failed to install 'typescript@${version}'.`;
    }
    static failedToUpdateMetadata(registry) {
        return `Failed to update metadata of the 'typescript' package from '${registry}'.`;
    }
    static maybeNetworkConnectionIssue() {
        return "Might be there is an issue with the registry or the network connection.";
    }
    static maybeOutdatedResolution(tag) {
        return `The resolution of the '${tag}' tag may be outdated.`;
    }
    static requestFailedWithStatusCode(code) {
        return `The request failed with status code ${code}.`;
    }
    static requestTimeoutWasExceeded(timeout) {
        return `The request timeout of ${timeout / 1000}s was exceeded.`;
    }
    static lockWaitTimeoutWasExceeded(timeout) {
        return `Lock wait timeout of ${timeout / 1000}s was exceeded.`;
    }
}

class Fetcher {
    #onDiagnostics;
    #timeout;
    constructor(onDiagnostics, timeout) {
        this.#onDiagnostics = onDiagnostics;
        this.#timeout = timeout;
    }
    async get(request, diagnostic, options) {
        try {
            const response = await fetch(request, { signal: AbortSignal.timeout(this.#timeout) });
            if (!response.ok) {
                !options?.suppressErrors &&
                    this.#onDiagnostics(diagnostic.extendWith(StoreDiagnosticText.requestFailedWithStatusCode(response.status)));
                return;
            }
            return response;
        }
        catch (error) {
            if (error instanceof Error && error.name === "TimeoutError") {
                !options?.suppressErrors &&
                    this.#onDiagnostics(diagnostic.extendWith(StoreDiagnosticText.requestTimeoutWasExceeded(this.#timeout)));
            }
            else {
                !options?.suppressErrors &&
                    this.#onDiagnostics(diagnostic.extendWith(StoreDiagnosticText.maybeNetworkConnectionIssue()));
            }
        }
        return;
    }
}

class Lock {
    #lockFilePath;
    constructor(lockFilePath) {
        this.#lockFilePath = lockFilePath;
        writeFileSync(this.#lockFilePath, "");
        process.on("exit", () => {
            this.release();
        });
    }
    release() {
        rmSync(this.#lockFilePath, { force: true });
    }
}

class LockService {
    #onDiagnostics;
    #timeout;
    constructor(onDiagnostics, timeout) {
        this.#onDiagnostics = onDiagnostics;
        this.#timeout = timeout;
    }
    #getLockFilePath(targetPath) {
        return `${targetPath}__lock__`;
    }
    getLock(targetPath) {
        const lockFilePath = this.#getLockFilePath(targetPath);
        return new Lock(lockFilePath);
    }
    async isLocked(targetPath, diagnostic) {
        const lockFilePath = this.#getLockFilePath(targetPath);
        let isLocked = existsSync(lockFilePath);
        if (!isLocked) {
            return isLocked;
        }
        const waitStartTime = Date.now();
        while (isLocked) {
            if (Date.now() - waitStartTime > this.#timeout) {
                this.#onDiagnostics(diagnostic.extendWith(StoreDiagnosticText.lockWaitTimeoutWasExceeded(this.#timeout)));
                break;
            }
            await this.#sleep(1000);
            isLocked = existsSync(lockFilePath);
        }
        return isLocked;
    }
    async #sleep(delay) {
        return new Promise((resolve) => setTimeout(resolve, delay));
    }
}

class Manifest {
    static #version = "2";
    $version;
    lastUpdated;
    npmRegistry;
    packages;
    resolutions;
    versions;
    constructor(data) {
        this.$version = data.$version ?? Manifest.#version;
        this.lastUpdated = data.lastUpdated ?? Date.now();
        this.npmRegistry = data.npmRegistry;
        this.packages = data.packages;
        this.resolutions = data.resolutions;
        this.versions = data.versions;
    }
    isOutdated(options) {
        if (Date.now() - this.lastUpdated > 2 * 60 * 60 * 1000 + (options?.ageTolerance ?? 0) * 1000) {
            return true;
        }
        return false;
    }
    static parse(text) {
        let manifestData;
        try {
            manifestData = JSON.parse(text);
        }
        catch {
        }
        if (manifestData != null && manifestData.$version === Manifest.#version) {
            return new Manifest(manifestData);
        }
        return;
    }
    resolve(tag) {
        if (this.versions.includes(tag)) {
            return tag;
        }
        return this.resolutions[tag];
    }
    stringify() {
        const manifestData = {
            $version: this.$version,
            lastUpdated: this.lastUpdated,
            npmRegistry: this.npmRegistry,
            packages: this.packages,
            resolutions: this.resolutions,
            versions: this.versions,
        };
        return JSON.stringify(manifestData);
    }
}

class ManifestService {
    #fetcher;
    #manifestFilePath;
    #npmRegistry;
    #storePath;
    constructor(storePath, npmRegistry, fetcher) {
        this.#storePath = storePath;
        this.#npmRegistry = npmRegistry;
        this.#fetcher = fetcher;
        this.#manifestFilePath = Path.join(storePath, "store-manifest.json");
    }
    async #create() {
        const manifest = await this.#load();
        if (manifest != null) {
            await this.#persist(manifest);
        }
        return manifest;
    }
    async #load(options) {
        const diagnostic = Diagnostic.error(StoreDiagnosticText.failedToFetchMetadata(this.#npmRegistry));
        const request = new Request(new URL("typescript", this.#npmRegistry), {
            headers: {
                ["Accept"]: "application/vnd.npm.install-v1+json;q=1.0, application/json;q=0.8, */*",
            },
        });
        const response = await this.#fetcher.get(request, diagnostic, { suppressErrors: options?.suppressErrors });
        if (!response) {
            return;
        }
        const resolutions = {};
        const packages = {};
        const versions = [];
        const packageMetadata = (await response.json());
        for (const [tag, meta] of Object.entries(packageMetadata.versions)) {
            if (/^(4|5)\.\d\.\d$/.test(tag)) {
                versions.push(tag);
                packages[tag] = { integrity: meta.dist.integrity, tarball: meta.dist.tarball };
            }
        }
        const minorVersions = [...new Set(versions.map((version) => version.slice(0, -2)))];
        for (const tag of minorVersions) {
            const resolvedVersion = versions.findLast((version) => version.startsWith(tag));
            if (resolvedVersion != null) {
                resolutions[tag] = resolvedVersion;
            }
        }
        for (const tag of ["beta", "latest", "next", "rc"]) {
            const version = packageMetadata["dist-tags"][tag];
            if (version != null) {
                resolutions[tag] = version;
                const meta = packageMetadata.versions[version];
                if (meta != null) {
                    packages[version] = { integrity: meta.dist.integrity, tarball: meta.dist.tarball };
                }
            }
        }
        return new Manifest({ npmRegistry: this.#npmRegistry, packages, resolutions, versions });
    }
    async open(options) {
        if (!existsSync(this.#manifestFilePath)) {
            return this.#create();
        }
        const manifestText = await fs.readFile(this.#manifestFilePath, { encoding: "utf8" });
        const manifest = Manifest.parse(manifestText);
        if (!manifest || manifest.npmRegistry !== this.#npmRegistry) {
            await this.prune();
            return this.#create();
        }
        if (manifest.isOutdated() || options?.refresh === true) {
            const freshManifest = await this.#load({ suppressErrors: !options?.refresh });
            if (freshManifest != null) {
                await this.#persist(freshManifest);
                return freshManifest;
            }
        }
        return manifest;
    }
    async #persist(manifest) {
        if (!existsSync(this.#storePath)) {
            await fs.mkdir(this.#storePath, { recursive: true });
        }
        await fs.writeFile(this.#manifestFilePath, manifest.stringify());
    }
    async prune() {
        await fs.rm(this.#storePath, { force: true, recursive: true });
    }
}

class TarReader {
    static #textDecoder = new TextDecoder();
    static async *extract(stream) {
        const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
        const buffer = await streamConsumers.arrayBuffer(decompressedStream);
        let offset = 0;
        while (offset < buffer.byteLength - 512) {
            const name = TarReader.#read(buffer, offset, 100);
            if (name.length === 0) {
                break;
            }
            const size = Number.parseInt(TarReader.#read(buffer, offset + 124, 12), 8);
            const contents = new Uint8Array(buffer, offset + 512, size);
            yield { name, contents };
            offset += 512 + 512 * Math.trunc(size / 512);
            if (size % 512) {
                offset += 512;
            }
        }
    }
    static #read(buffer, byteOffset, length) {
        let view = new Uint8Array(buffer, byteOffset, length);
        const zeroIndex = view.indexOf(0);
        if (zeroIndex !== -1) {
            view = view.subarray(0, zeroIndex);
        }
        return TarReader.#textDecoder.decode(view);
    }
}

class PackageService {
    #fetcher;
    #lockService;
    #storePath;
    constructor(storePath, fetcher, lockService) {
        this.#storePath = storePath;
        this.#fetcher = fetcher;
        this.#lockService = lockService;
    }
    async #add(packagePath, resource, diagnostic) {
        const request = new Request(resource.tarball, { integrity: resource.integrity });
        const response = await this.#fetcher.get(request, diagnostic);
        if (response?.body != null) {
            const targetPath = `${packagePath}-${Math.random().toString(32).slice(2)}`;
            for await (const file of TarReader.extract(response.body)) {
                if (!file.name.startsWith("package/")) {
                    continue;
                }
                const filePath = Path.join(targetPath, file.name.replace("package/", ""));
                const directoryPath = Path.dirname(filePath);
                if (!existsSync(directoryPath)) {
                    await fs.mkdir(directoryPath, { recursive: true });
                }
                await fs.writeFile(filePath, file.contents);
            }
            await fs.rename(targetPath, packagePath);
            return packagePath;
        }
        return;
    }
    async ensure(packageVersion, manifest) {
        let packagePath = Path.join(this.#storePath, `typescript@${packageVersion}`);
        const diagnostic = Diagnostic.error(StoreDiagnosticText.failedToInstalTypeScript(packageVersion));
        if (await this.#lockService.isLocked(packagePath, diagnostic)) {
            return;
        }
        if (existsSync(packagePath)) {
            return packagePath;
        }
        EventEmitter.dispatch(["store:adds", { packagePath, packageVersion }]);
        const resource = manifest?.packages[packageVersion];
        if (resource != null) {
            const lock = this.#lockService.getLock(packagePath);
            try {
                packagePath = await this.#add(packagePath, resource, diagnostic);
            }
            finally {
                lock.release();
            }
            return packagePath;
        }
        return;
    }
}

class StoreService {
    #compilerInstanceCache = new Map();
    #fetcher;
    #lockService;
    #manifest;
    #manifestService;
    #packageService;
    #npmRegistry = environmentOptions.npmRegistry;
    #storePath = environmentOptions.storePath;
    #supportedTags;
    #timeout = environmentOptions.timeout * 1000;
    constructor() {
        this.#fetcher = new Fetcher(this.#onDiagnostics, this.#timeout);
        this.#lockService = new LockService(this.#onDiagnostics, this.#timeout);
        this.#packageService = new PackageService(this.#storePath, this.#fetcher, this.#lockService);
        this.#manifestService = new ManifestService(this.#storePath, this.#npmRegistry, this.#fetcher);
    }
    async getSupportedTags() {
        await this.open();
        return this.#supportedTags;
    }
    async install(tag) {
        if (tag === "current") {
            return;
        }
        await this.open();
        const version = this.#manifest?.resolve(tag);
        if (!version) {
            this.#onDiagnostics(Diagnostic.error(StoreDiagnosticText.cannotAddTypeScriptPackage(tag)));
            return;
        }
        await this.#packageService.ensure(version, this.#manifest);
    }
    async load(tag) {
        let compilerInstance = this.#compilerInstanceCache.get(tag);
        if (compilerInstance != null) {
            return compilerInstance;
        }
        let modulePath;
        if (tag === "current" && environmentOptions.typescriptPath != null) {
            modulePath = environmentOptions.typescriptPath;
        }
        else {
            await this.open();
            const version = this.#manifest?.resolve(tag);
            if (!version) {
                this.#onDiagnostics(Diagnostic.error(StoreDiagnosticText.cannotAddTypeScriptPackage(tag)));
                return;
            }
            compilerInstance = this.#compilerInstanceCache.get(version);
            if (compilerInstance != null) {
                return compilerInstance;
            }
            const packagePath = await this.#packageService.ensure(version, this.#manifest);
            if (packagePath != null) {
                modulePath = Path.join(packagePath, "lib", "typescript.js");
            }
        }
        if (modulePath != null) {
            compilerInstance = await this.#loadModule(modulePath);
            this.#compilerInstanceCache.set(tag, compilerInstance);
            this.#compilerInstanceCache.set(compilerInstance.version, compilerInstance);
        }
        return compilerInstance;
    }
    async #loadModule(modulePath) {
        const exports = {};
        const module = { exports };
        const candidatePaths = [Path.join(Path.dirname(modulePath), "tsserverlibrary.js"), modulePath];
        for (const candidatePath of candidatePaths) {
            const sourceText = await fs.readFile(candidatePath, { encoding: "utf8" });
            if (!sourceText.includes("isTypeRelatedTo")) {
                continue;
            }
            const toExpose = [
                "getTypeOfSymbol",
                "isTypeRelatedTo",
                "relation: { assignable: assignableRelation, identity: identityRelation, subtype: strictSubtypeRelation }",
            ];
            const modifiedSourceText = sourceText.replace("return checker;", `return { ...checker, ${toExpose.join(", ")} };`);
            const compiledWrapper = vm.compileFunction(modifiedSourceText, ["exports", "require", "module", "__filename", "__dirname"], { filename: candidatePath });
            compiledWrapper(exports, createRequire(candidatePath), module, candidatePath, Path.dirname(candidatePath));
            break;
        }
        return module.exports;
    }
    #onDiagnostics(diagnostic) {
        EventEmitter.dispatch(["store:error", { diagnostics: [diagnostic] }]);
    }
    async open() {
        this.open = () => Promise.resolve();
        this.#manifest = await this.#manifestService.open();
        if (this.#manifest != null) {
            this.#supportedTags = [...Object.keys(this.#manifest.resolutions), ...this.#manifest.versions, "current"].sort();
        }
    }
    async prune() {
        await this.#manifestService.prune();
    }
    async update() {
        await this.#manifestService.open({ refresh: true });
    }
    async validateTag(tag) {
        if (tag === "current") {
            return environmentOptions.typescriptPath != null;
        }
        await this.open();
        if (this.#manifest?.isOutdated({ ageTolerance: 60 }) &&
            (!Version.isVersionTag(tag) ||
                (this.#manifest.resolutions["latest"] != null &&
                    Version.isGreaterThan(tag, this.#manifest.resolutions["latest"])))) {
            this.#onDiagnostics(Diagnostic.warning([
                StoreDiagnosticText.failedToUpdateMetadata(this.#npmRegistry),
                StoreDiagnosticText.maybeOutdatedResolution(tag),
            ]));
        }
        return this.#supportedTags?.includes(tag);
    }
}

class Cli {
    #eventEmitter = new EventEmitter();
    #outputService = new OutputService();
    async run(commandLineArguments, cancellationToken = new CancellationToken()) {
        const exitCodeHandler = new ExitCodeHandler();
        this.#eventEmitter.addHandler(exitCodeHandler);
        const setupReporter = new SetupReporter(this.#outputService);
        this.#eventEmitter.addHandler(setupReporter);
        const cancellationHandler = new CancellationHandler(cancellationToken, "configError");
        this.#eventEmitter.addHandler(cancellationHandler);
        if (commandLineArguments.includes("--help")) {
            const commandLineOptionDefinitions = OptionDefinitionsMap.for(2);
            this.#outputService.writeMessage(helpText(commandLineOptionDefinitions, TSTyche.version));
            return;
        }
        if (commandLineArguments.includes("--version")) {
            this.#outputService.writeMessage(formattedText(TSTyche.version));
            return;
        }
        const storeService = new StoreService();
        if (commandLineArguments.includes("--prune")) {
            await storeService.prune();
            return;
        }
        if (commandLineArguments.includes("--update")) {
            await storeService.update();
            return;
        }
        const configService = new ConfigService();
        await configService.parseCommandLine(commandLineArguments, storeService);
        if (cancellationToken.isCancellationRequested) {
            return;
        }
        do {
            if (cancellationToken.reason === "configChange") {
                cancellationToken.reset();
                exitCodeHandler.resetCode();
                this.#outputService.clearTerminal();
                this.#eventEmitter.addHandler(setupReporter);
                this.#eventEmitter.addHandler(cancellationHandler);
            }
            await configService.readConfigFile(storeService);
            const resolvedConfig = configService.resolveConfig();
            if (cancellationToken.isCancellationRequested) {
                if (commandLineArguments.includes("--watch")) {
                    await this.#waitForChangedFiles(resolvedConfig, undefined, cancellationToken);
                }
                continue;
            }
            if (commandLineArguments.includes("--showConfig")) {
                this.#outputService.writeMessage(formattedText({ ...resolvedConfig }));
                continue;
            }
            if (commandLineArguments.includes("--install")) {
                for (const tag of resolvedConfig.target) {
                    await storeService.install(tag);
                }
                continue;
            }
            const selectService = new SelectService(resolvedConfig);
            let testFiles = [];
            if (resolvedConfig.testFileMatch.length > 0) {
                testFiles = await selectService.selectFiles();
                if (testFiles.length === 0) {
                    if (commandLineArguments.includes("--watch")) {
                        await this.#waitForChangedFiles(resolvedConfig, selectService, cancellationToken);
                    }
                    continue;
                }
                if (commandLineArguments.includes("--listFiles")) {
                    this.#outputService.writeMessage(formattedText(testFiles));
                    continue;
                }
            }
            this.#eventEmitter.removeHandler(setupReporter);
            this.#eventEmitter.removeHandler(cancellationHandler);
            const tstyche = new TSTyche(resolvedConfig, this.#outputService, selectService, storeService);
            await tstyche.run(testFiles, cancellationToken);
            tstyche.close();
        } while (cancellationToken.reason === "configChange");
        this.#eventEmitter.removeHandlers();
    }
    #waitForChangedFiles(resolvedConfig, selectService, cancellationToken) {
        return new Promise((resolve) => {
            const watchers = [];
            cancellationToken.reset();
            this.#outputService.writeMessage(waitingForFileChangesText());
            const onChanged = () => {
                cancellationToken.cancel("configChange");
                for (const watcher of watchers) {
                    watcher.close();
                }
                resolve();
            };
            watchers.push(new FileWatcher(resolvedConfig.configFilePath, onChanged));
            if (selectService != null) {
                const onChangedTestFile = (filePath) => {
                    if (selectService.isTestFile(filePath)) {
                        onChanged();
                    }
                };
                const onRemoved = () => {
                };
                watchers.push(new Watcher(resolvedConfig.rootPath, onChangedTestFile, onRemoved, { recursive: true }));
            }
            for (const watcher of watchers) {
                watcher.watch();
            }
        });
    }
}

export { Assertion, CancellationHandler, CancellationReason, CancellationToken, Cli, CollectService, Color, ConfigDiagnosticText, ConfigService, DescribeResult, Diagnostic, DiagnosticCategory, DiagnosticOrigin, EventEmitter, ExitCodeHandler, ExpectResult, ExpectService, FileWatcher, InputService, Line, OptionBrand, OptionDefinitionsMap, OptionGroup, OutputService, Path, ProjectResult, ProjectService, Result, ResultCount, ResultHandler, ResultStatus, ResultTiming, RunReporter, Runner, Scribbler, SelectDiagnosticText, SelectService, SetupReporter, SourceFile, StoreService, SummaryReporter, TSTyche, TargetResult, Task, TaskResult, TestMember, TestMemberBrand, TestMemberFlags, TestResult, TestTree, Text, Version, WatchReporter, WatchService, Watcher, addsPackageText, defaultOptions, describeNameText, diagnosticText, environmentOptions, fileViewText, formattedText, helpText, summaryText, taskStatusText, testNameText, usesCompilerText, waitingForFileChangesText, watchUsageText };
