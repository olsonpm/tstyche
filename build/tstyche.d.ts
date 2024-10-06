import type ts from 'typescript';

declare enum OptionBrand {
    String = "string",
    Number = "number",
    Boolean = "boolean",
    BareTrue = "bareTrue",// a boolean option that does not take a value and when specified is interpreted as 'true'
    List = "list"
}

declare enum OptionGroup {
    CommandLine = 2,
    ConfigFile = 4
}

declare class ConfigDiagnosticText {
    #private;
    static expected(element: string): string;
    static expectsListItemType(optionName: string, optionBrand: OptionBrand): string;
    static expectsValue(optionName: string, optionGroup: OptionGroup): string;
    static fileDoesNotExist(filePath: string): string;
    static seen(element: string): string;
    static testFileMatchCannotStartWith(segment: string): Array<string>;
    static requiresValueType(optionName: string, optionBrand: OptionBrand, optionGroup: OptionGroup): string;
    static unknownOption(optionName: string): string;
    static versionIsNotSupported(value: string): string;
    static watchCannotBeEnabled(): string;
}

declare class StoreService {
    #private;
    constructor();
    getSupportedTags(): Promise<Array<string> | undefined>;
    install(tag: string): Promise<void>;
    load(tag: string): Promise<typeof ts | undefined>;
    open(): Promise<void>;
    prune(): Promise<void>;
    update(): Promise<void>;
    validateTag(tag: string): Promise<boolean | undefined>;
}

declare enum DiagnosticCategory {
    Error = "error",
    Warning = "warning"
}

declare enum TestMemberBrand {
    Describe = "describe",
    Test = "test",
    Expect = "expect"
}

declare enum TestMemberFlags {
    None = 0,
    Fail = 1,
    Only = 2,
    Skip = 4,
    Todo = 8
}

declare class TestTree {
    diagnostics: Set<ts.Diagnostic>;
    members: Array<TestMember | Assertion>;
    sourceFile: ts.SourceFile;
    constructor(diagnostics: Set<ts.Diagnostic>, sourceFile: ts.SourceFile);
    get hasOnly(): boolean;
}

declare class TestMember {
    #private;
    brand: TestMemberBrand;
    diagnostics: Set<ts.Diagnostic>;
    flags: TestMemberFlags;
    members: Array<TestMember | Assertion>;
    name: string;
    node: ts.CallExpression;
    parent: TestTree | TestMember;
    constructor(compiler: typeof ts, brand: TestMemberBrand, node: ts.CallExpression, parent: TestTree | TestMember, flags: TestMemberFlags);
    validate(): Array<Diagnostic>;
}

interface MatcherNode extends ts.CallExpression {
    expression: ts.PropertyAccessExpression;
}
declare class Assertion extends TestMember {
    isNot: boolean;
    matcherNode: MatcherNode;
    modifierNode: ts.PropertyAccessExpression;
    notNode: ts.PropertyAccessExpression | undefined;
    constructor(compiler: typeof ts, brand: TestMemberBrand, node: ts.CallExpression, parent: TestTree | TestMember, flags: TestMemberFlags, matcherNode: MatcherNode, modifierNode: ts.PropertyAccessExpression, notNode?: ts.PropertyAccessExpression);
    get matcherName(): ts.MemberName;
    get source(): ts.NodeArray<ts.Expression> | ts.NodeArray<ts.TypeNode>;
    get target(): ts.NodeArray<ts.Expression> | ts.NodeArray<ts.TypeNode>;
}

declare class CollectService {
    #private;
    constructor(compiler: typeof ts);
    createTestTree(sourceFile: ts.SourceFile, semanticDiagnostics?: Array<ts.Diagnostic>): TestTree;
}

declare class SourceFile {
    #private;
    fileName: string;
    text: string;
    constructor(fileName: string, text: string);
    getLineStarts(): Array<number>;
    getLineAndCharacterOfPosition(position: number): {
        line: number;
        character: number;
    };
}

declare class DiagnosticOrigin {
    assertion: Assertion | undefined;
    end: number;
    sourceFile: SourceFile | ts.SourceFile;
    start: number;
    constructor(start: number, end: number, sourceFile: SourceFile | ts.SourceFile, assertion?: Assertion);
    static fromAssertion(assertion: Assertion): DiagnosticOrigin;
    static fromNode(node: ts.Node, assertion?: Assertion): DiagnosticOrigin;
}

declare class Diagnostic {
    #private;
    category: DiagnosticCategory;
    code: string | undefined;
    origin: DiagnosticOrigin | undefined;
    related: Array<Diagnostic> | undefined;
    text: string | Array<string>;
    constructor(text: string | Array<string>, category: DiagnosticCategory, origin?: DiagnosticOrigin);
    add(options: {
        code?: string | undefined;
        related?: Array<Diagnostic> | undefined;
    }): this;
    static error(text: string | Array<string>, origin?: DiagnosticOrigin): Diagnostic;
    extendWith(text: string | Array<string>, origin?: DiagnosticOrigin): Diagnostic;
    static fromDiagnostics(diagnostics: Array<ts.Diagnostic>, compiler: typeof ts): Array<Diagnostic>;
    static warning(text: string | Array<string>, origin?: DiagnosticOrigin): Diagnostic;
}

/**
 * Options loaded from the configuration file.
 */
interface ConfigFileOptions {
    /**
     * Stop running tests after the first failed assertion.
     */
    failFast?: boolean;
    /**
     * The path to a directory containing files of a test project.
     */
    rootPath?: string;
    /**
     * The list of TypeScript versions to be tested on.
     */
    target?: Array<string>;
    /**
     * The list of glob patterns matching the test files.
     */
    testFileMatch?: Array<string>;
}

/**
 * Options passed through the command line.
 */
interface CommandLineOptions {
    /**
     * The path to a TSTyche configuration file.
     */
    config?: string;
    /**
     * Stop running tests after the first failed assertion.
     */
    failFast?: boolean;
    /**
     * Print the list of command line options with brief descriptions and exit.
     */
    help?: boolean;
    /**
     * Install specified versions of the 'typescript' package and exit.
     */
    install?: boolean;
    /**
     * Print the list of the selected test files and exit.
     */
    listFiles?: boolean;
    /**
     * Only run tests with matching name.
     */
    only?: string;
    /**
     * Remove all installed versions of the 'typescript' package and exit.
     */
    prune?: boolean;
    /**
     * Print the resolved configuration and exit.
     */
    showConfig?: boolean;
    /**
     * Skip tests with matching name.
     */
    skip?: string;
    /**
     * The list of TypeScript versions to be tested on.
     */
    target?: Array<string>;
    /**
     * Fetch the 'typescript' package metadata from the registry and exit.
     */
    update?: boolean;
    /**
     * Print the version number and exit.
     */
    version?: boolean;
    /**
     * Watch for changes and rerun related test files.
     */
    watch?: boolean;
}

interface EnvironmentOptions {
    /**
     * Is `true` if the process is running in a continuous integration environment.
     */
    isCi: boolean;
    /**
     * Specifies whether color should be disabled in the output.
     */
    noColor: boolean;
    /**
     * Specifies whether interactive elements should be disabled in the output.
     */
    noInteractive: boolean;
    /**
     * The base URL of the 'npm' registry to use.
     */
    npmRegistry: string;
    /**
     * The directory where to store the 'typescript' packages.
     */
    storePath: string;
    /**
     * The number of seconds to wait before giving up stale operations.
     */
    timeout: number;
    /**
     * The path to the currently installed TypeScript module.
     */
    typescriptPath: string | undefined;
}

interface ResolvedConfig extends EnvironmentOptions, Omit<CommandLineOptions, keyof ConfigFileOptions | "config">, Required<ConfigFileOptions> {
    /**
     * The path to a TSTyche configuration file.
     */
    configFilePath: string;
    /**
     * Only run test files with matching path.
     */
    pathMatch: Array<string>;
}
declare class ConfigService {
    #private;
    parseCommandLine(commandLineArgs: Array<string>, storeService: StoreService): Promise<void>;
    readConfigFile(storeService: StoreService): Promise<void>;
    resolveConfig(): ResolvedConfig;
}

interface ItemDefinition {
    brand: OptionBrand.String;
    name: string;
    pattern?: string;
}
type OptionDefinition = PrimitiveTypeOptionDefinition | ListTypeOptionDefinition;
interface BaseOptionDefinition {
    brand: OptionBrand;
    description: string;
    group: OptionGroup;
    name: string;
}
interface PrimitiveTypeOptionDefinition extends BaseOptionDefinition {
    brand: OptionBrand.String | OptionBrand.Number | OptionBrand.Boolean | OptionBrand.BareTrue;
}
interface ListTypeOptionDefinition extends BaseOptionDefinition {
    brand: OptionBrand.List;
    items: ItemDefinition;
}
declare class OptionDefinitionsMap {
    #private;
    static for(optionGroup: OptionGroup): Map<string, OptionDefinition>;
}

declare const defaultOptions: Required<ConfigFileOptions>;

declare const environmentOptions: EnvironmentOptions;

declare enum Color {
    Reset = "0",
    Red = "31",
    Green = "32",
    Yellow = "33",
    Blue = "34",
    Magenta = "35",
    Cyan = "36",
    Gray = "90"
}

type ScribblerNode = Array<ScribblerNode> | ScribblerJsx.Element | string | number | undefined;
type FunctionComponent = (props: Record<string, unknown>) => ScribblerJsx.Element;
declare namespace ScribblerJsx {
    interface Element {
        props: Record<string, unknown>;
        type: FunctionComponent | number | string;
    }
    interface ElementChildrenAttribute {
        children: ScribblerNode;
    }
    interface IntrinsicElements {
        ansi: {
            escapes: Color | Array<Color>;
        };
        newLine: {};
        text: {
            children: Array<ScribblerNode>;
            indent: number;
        };
    }
}

interface LineProps {
    children?: ScribblerNode;
    color?: Color;
    indent?: number;
}
declare function Line({ children, color, indent }: LineProps): ScribblerJsx.Element;

interface ScribblerOptions {
    newLine?: string;
    noColor?: boolean;
}
declare class Scribbler {
    #private;
    constructor(options?: ScribblerOptions);
    render(element: ScribblerJsx.Element): string;
}

interface TextProps {
    children?: ScribblerNode;
    color?: Color | undefined;
    indent?: number | undefined;
}
declare function Text({ children, color, indent }: TextProps): ScribblerJsx.Element;

declare function addsPackageText(packageVersion: string, packagePath: string): ScribblerJsx.Element;

declare function describeNameText(name: string, indent?: number): ScribblerJsx.Element;

declare function diagnosticText(diagnostic: Diagnostic): ScribblerJsx.Element;

declare class ResultTiming {
    end: number;
    start: number;
    get duration(): number;
}

declare enum ResultStatus {
    Runs = "runs",
    Passed = "passed",
    Failed = "failed",
    Skipped = "skipped",
    Todo = "todo"
}

declare class ExpectResult {
    assertion: Assertion;
    diagnostics: Array<Diagnostic>;
    parent: TestResult | undefined;
    status: ResultStatus;
    timing: ResultTiming;
    constructor(assertion: Assertion, parent?: TestResult);
}

declare class ResultCount {
    failed: number;
    passed: number;
    skipped: number;
    todo: number;
    get total(): number;
}

declare class TestResult {
    diagnostics: Array<Diagnostic>;
    expectCount: ResultCount;
    parent: DescribeResult | undefined;
    results: Array<ExpectResult>;
    status: ResultStatus;
    test: TestMember;
    timing: ResultTiming;
    constructor(test: TestMember, parent?: DescribeResult);
}

declare class DescribeResult {
    describe: TestMember;
    parent: DescribeResult | undefined;
    results: Array<DescribeResult | TestResult>;
    timing: ResultTiming;
    constructor(describe: TestMember, parent?: DescribeResult);
}

declare class Task {
    #private;
    filePath: string;
    position: number | undefined;
    constructor(filePath: string | URL, position?: number);
}

type TaskResultStatus = ResultStatus.Runs | ResultStatus.Passed | ResultStatus.Failed;
declare class TaskResult {
    diagnostics: Array<Diagnostic>;
    expectCount: ResultCount;
    results: Array<DescribeResult | TestResult | ExpectResult>;
    status: TaskResultStatus;
    task: Task;
    testCount: ResultCount;
    timing: ResultTiming;
    constructor(task: Task);
}

declare class ProjectResult {
    compilerVersion: string;
    diagnostics: Array<Diagnostic>;
    projectConfigFilePath: string | undefined;
    results: Array<TaskResult>;
    constructor(compilerVersion: string, projectConfigFilePath: string | undefined);
}

type TargetResultStatus = ResultStatus.Runs | ResultStatus.Passed | ResultStatus.Failed;
declare class TargetResult {
    results: Map<string | undefined, ProjectResult>;
    status: TargetResultStatus;
    tasks: Array<Task>;
    timing: ResultTiming;
    versionTag: string;
    constructor(versionTag: string, tasks: Array<Task>);
}

declare class Result {
    expectCount: ResultCount;
    fileCount: ResultCount;
    resolvedConfig: ResolvedConfig;
    results: Array<TargetResult>;
    targetCount: ResultCount;
    tasks: Array<Task>;
    testCount: ResultCount;
    timing: ResultTiming;
    constructor(resolvedConfig: ResolvedConfig, tasks: Array<Task>);
}

declare function taskStatusText(status: TaskResultStatus, task: Task): ScribblerJsx.Element;

declare function fileViewText(lines: Array<ScribblerJsx.Element>, addEmptyFinalLine: boolean): ScribblerJsx.Element;

declare function formattedText(input: string | Array<string> | Record<string, unknown>): ScribblerJsx.Element;

declare function helpText(optionDefinitions: Map<string, OptionDefinition>, tstycheVersion: string): ScribblerJsx.Element;

declare class OutputService {
    #private;
    constructor();
    clearTerminal(): void;
    eraseLastLine(): void;
    writeError(element: ScribblerJsx.Element | Array<ScribblerJsx.Element>): void;
    writeMessage(element: ScribblerJsx.Element | Array<ScribblerJsx.Element>): void;
    writeWarning(element: ScribblerJsx.Element | Array<ScribblerJsx.Element>): void;
}

declare function summaryText({ duration, expectCount, fileCount, onlyMatch, pathMatch, skipMatch, targetCount, testCount, }: {
    duration: number;
    expectCount: ResultCount;
    fileCount: ResultCount;
    onlyMatch: string | undefined;
    pathMatch: Array<string>;
    skipMatch: string | undefined;
    targetCount: ResultCount;
    testCount: ResultCount;
}): ScribblerJsx.Element;

declare function testNameText(status: "fail" | "pass" | "skip" | "todo", name: string, indent?: number): ScribblerJsx.Element;

declare function usesCompilerText(compilerVersion: string, projectConfigFilePath: string | undefined, options?: {
    prependEmptyLine: boolean;
}): ScribblerJsx.Element;

declare function waitingForFileChangesText(): ScribblerJsx.Element;

declare function watchUsageText(): ScribblerJsx.Element;

declare class SelectDiagnosticText {
    #private;
    static noTestFilesWereLeft(resolvedConfig: ResolvedConfig): Array<string>;
    static noTestFilesWereSelected(resolvedConfig: ResolvedConfig): Array<string>;
}

declare class SelectService {
    #private;
    constructor(resolvedConfig: ResolvedConfig);
    isTestFile(filePath: string): boolean;
    selectFiles(): Promise<Array<string>>;
}

declare enum CancellationReason {
    ConfigChange = "configChange",
    ConfigError = "configError",
    FailFast = "failFast",
    WatchClose = "watchClose"
}

declare class CancellationToken {
    #private;
    get isCancellationRequested(): boolean;
    get reason(): CancellationReason | undefined;
    cancel(reason: CancellationReason): void;
    reset(): void;
}

declare class TSTyche {
    #private;
    static version: string;
    constructor(resolvedConfig: ResolvedConfig, outputService: OutputService, selectService: SelectService, storeService: StoreService);
    close(): void;
    run(testFiles: Array<string | URL>, cancellationToken?: CancellationToken): Promise<void>;
}

declare class Cli {
    #private;
    run(commandLineArguments: Array<string>, cancellationToken?: CancellationToken): Promise<void>;
}

type Event = ["config:error", {
    diagnostics: Array<Diagnostic>;
}] | ["deprecation:info", {
    diagnostics: Array<Diagnostic>;
}] | ["select:error", {
    diagnostics: Array<Diagnostic>;
}] | ["run:start", {
    result: Result;
}] | ["run:end", {
    result: Result;
}] | ["store:adds", {
    packagePath: string;
    packageVersion: string;
}] | ["store:error", {
    diagnostics: Array<Diagnostic>;
}] | ["target:start", {
    result: TargetResult;
}] | ["target:end", {
    result: TargetResult;
}] | ["project:uses", {
    compilerVersion: string;
    projectConfigFilePath: string | undefined;
}] | ["project:error", {
    diagnostics: Array<Diagnostic>;
}] | ["task:start", {
    result: TaskResult;
}] | ["task:error", {
    diagnostics: Array<Diagnostic>;
    result: TaskResult;
}] | ["task:end", {
    result: TaskResult;
}] | ["describe:start", {
    result: DescribeResult;
}] | ["describe:end", {
    result: DescribeResult;
}] | ["test:start", {
    result: TestResult;
}] | ["test:error", {
    diagnostics: Array<Diagnostic>;
    result: TestResult;
}] | ["test:fail", {
    result: TestResult;
}] | ["test:pass", {
    result: TestResult;
}] | ["test:skip", {
    result: TestResult;
}] | ["test:todo", {
    result: TestResult;
}] | ["expect:start", {
    result: ExpectResult;
}] | ["expect:error", {
    diagnostics: Array<Diagnostic>;
    result: ExpectResult;
}] | ["expect:fail", {
    diagnostics: Array<Diagnostic>;
    result: ExpectResult;
}] | ["expect:pass", {
    result: ExpectResult;
}] | ["expect:skip", {
    result: ExpectResult;
}] | ["watch:error", {
    diagnostics: Array<Diagnostic>;
}];

interface EventHandler {
    handleEvent: (event: Event) => void;
}
declare class EventEmitter {
    #private;
    addHandler(handler: EventHandler): void;
    static dispatch(event: Event): void;
    removeHandler(handler: EventHandler): void;
    removeHandlers(): void;
}

type ArgumentNode = ts.Expression | ts.TypeNode;
type DiagnosticsHandler = (diagnostics: Diagnostic | Array<Diagnostic>) => void;
interface MatchResult {
    explain: () => Array<Diagnostic>;
    isMatch: boolean;
}
type Relation = Map<string, unknown>;
interface TypeChecker extends ts.TypeChecker {
    isTypeRelatedTo: (source: ts.Type, target: ts.Type, relation: Relation) => boolean;
    relation: {
        assignable: Relation;
        identity: Relation;
        subtype: Relation;
    };
}

declare class MatchWorker {
    #private;
    assertion: Assertion;
    constructor(compiler: typeof ts, typeChecker: TypeChecker, assertion: Assertion);
    checkIsAssignableTo(sourceNode: ArgumentNode, targetNode: ArgumentNode): boolean;
    checkIsAssignableWith(sourceNode: ArgumentNode, targetNode: ArgumentNode): boolean;
    checkIsIdenticalTo(sourceNode: ArgumentNode, targetNode: ArgumentNode): boolean;
    checkIsSubtype(sourceNode: ArgumentNode, targetNode: ArgumentNode): boolean;
    extendsObjectType(type: ts.Type): boolean;
    getParameterType(signature: ts.Signature, index: number): ts.Type | undefined;
    getSignatures(node: ArgumentNode): Array<ts.Signature>;
    getTypeText(node: ArgumentNode): string;
    getType(node: ArgumentNode): ts.Type;
    isAnyOrNeverType(type: ts.Type): type is ts.StringLiteralType | ts.NumberLiteralType;
    isStringOrNumberLiteralType(type: ts.Type): type is ts.StringLiteralType | ts.NumberLiteralType;
    isObjectType(type: ts.Type): type is ts.ObjectType;
    isUnionType(type: ts.Type): type is ts.UnionType;
    isUniqueSymbolType(type: ts.Type): type is ts.UniqueESSymbolType;
    resolveDiagnosticOrigin(symbol: ts.Symbol, enclosingNode: ts.Node): DiagnosticOrigin;
}

declare class PrimitiveTypeMatcher {
    #private;
    constructor(targetTypeFlag: ts.TypeFlags);
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode): MatchResult;
}

declare class ToAcceptProps {
    #private;
    constructor(compiler: typeof ts, typeChecker: TypeChecker);
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode, onDiagnostics: DiagnosticsHandler): MatchResult | undefined;
}

declare class ExpectDiagnosticText {
    static argumentOrTypeArgumentMustBeProvided(argumentNameText: string, typeArgumentNameText: string): string;
    static argumentMustBe(argumentNameText: string, expectedText: string): string;
    static argumentMustBeProvided(argumentNameText: string): string;
    static componentAcceptsProps(isTypeNode: boolean): string;
    static componentDoesNotAcceptProps(isTypeNode: boolean): string;
    static matcherIsDeprecated(matcherNameText: string): Array<string>;
    static matcherIsNotSupported(matcherNameText: string): string;
    static overloadGaveTheFollowingError(index: number, count: number, signatureText: string): string;
    static raisedTypeError(count?: number): string;
    static typeArgumentMustBe(argumentNameText: string, expectedText: string): string;
    static typeDidNotRaiseError(isTypeNode: boolean): string;
    static typeDidNotRaiseMatchingError(isTypeNode: boolean): string;
    static typeDoesNotHaveProperty(typeText: string, propertyNameText: string): string;
    static typeDoesMatch(sourceTypeText: string, targetTypeText: string): string;
    static typeDoesNotMatch(sourceTypeText: string, targetTypeText: string): string;
    static typeHasProperty(typeText: string, propertyNameText: string): string;
    static typeIs(typeText: string): string;
    static typeIsAssignableTo(sourceTypeText: string, targetTypeText: string): string;
    static typeIsAssignableWith(sourceTypeText: string, targetTypeText: string): string;
    static typeIsIdenticalTo(sourceTypeText: string, targetTypeText: string): string;
    static typeIsNotAssignableTo(sourceTypeText: string, targetTypeText: string): string;
    static typeIsNotAssignableWith(sourceTypeText: string, targetTypeText: string): string;
    static typeIsNotCompatibleWith(sourceTypeText: string, targetTypeText: string): string;
    static typeIsNotIdenticalTo(sourceTypeText: string, targetTypeText: string): string;
    static typeRaisedError(isTypeNode: boolean, count: number, targetCount: number): string;
    static typeRaisedMatchingError(isTypeNode: boolean): string;
    static typeRequiresProperty(typeText: string, propertyNameText: string): string;
    static typesOfPropertyAreNotCompatible(propertyNameText: string): string;
}

declare abstract class RelationMatcherBase {
    abstract explainText(sourceTypeText: string, targetTypeText: string): string;
    abstract explainNotText(sourceTypeText: string, targetTypeText: string): string;
    protected explain(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): Diagnostic[];
    abstract match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): MatchResult;
}

declare class ToBe extends RelationMatcherBase {
    explainText: typeof ExpectDiagnosticText.typeIsIdenticalTo;
    explainNotText: typeof ExpectDiagnosticText.typeIsNotIdenticalTo;
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): MatchResult;
}

declare class ToBeAssignableTo extends RelationMatcherBase {
    explainText: typeof ExpectDiagnosticText.typeIsAssignableTo;
    explainNotText: typeof ExpectDiagnosticText.typeIsNotAssignableTo;
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): MatchResult;
}

declare class ToBeAssignableWith extends RelationMatcherBase {
    explainText: typeof ExpectDiagnosticText.typeIsAssignableWith;
    explainNotText: typeof ExpectDiagnosticText.typeIsNotAssignableWith;
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): MatchResult;
}

declare class ToHaveProperty {
    #private;
    constructor(compiler: typeof ts);
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode, onDiagnostics: DiagnosticsHandler): MatchResult | undefined;
}

declare class ToMatch extends RelationMatcherBase {
    explainText: typeof ExpectDiagnosticText.typeDoesMatch;
    explainNotText: typeof ExpectDiagnosticText.typeDoesNotMatch;
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNode: ArgumentNode): MatchResult;
}

declare class ToRaiseError {
    #private;
    constructor(compiler: typeof ts);
    match(matchWorker: MatchWorker, sourceNode: ArgumentNode, targetNodes: Array<ArgumentNode>, onDiagnostics: DiagnosticsHandler): MatchResult | undefined;
}

declare class ExpectService {
    #private;
    toAcceptProps: ToAcceptProps;
    toBe: ToBe;
    toBeAny: PrimitiveTypeMatcher;
    toBeAssignableTo: ToBeAssignableTo;
    toBeAssignableWith: ToBeAssignableWith;
    toBeBigInt: PrimitiveTypeMatcher;
    toBeBoolean: PrimitiveTypeMatcher;
    toBeNever: PrimitiveTypeMatcher;
    toBeNull: PrimitiveTypeMatcher;
    toBeNumber: PrimitiveTypeMatcher;
    toBeString: PrimitiveTypeMatcher;
    toBeSymbol: PrimitiveTypeMatcher;
    toBeUndefined: PrimitiveTypeMatcher;
    toBeUniqueSymbol: PrimitiveTypeMatcher;
    toBeUnknown: PrimitiveTypeMatcher;
    toBeVoid: PrimitiveTypeMatcher;
    toHaveProperty: ToHaveProperty;
    toMatch: ToMatch;
    toRaiseError: ToRaiseError;
    constructor(compiler: typeof ts, typeChecker: TypeChecker);
    match(assertion: Assertion, onDiagnostics: DiagnosticsHandler): MatchResult | undefined;
}

declare class CancellationHandler implements EventHandler {
    #private;
    constructor(cancellationToken: CancellationToken, cancellationReason: CancellationReason);
    handleEvent([, payload]: Event): void;
}

declare class ExitCodeHandler implements EventHandler {
    #private;
    handleEvent([eventName, payload]: Event): void;
    resetCode(): void;
}

declare class ResultHandler implements EventHandler {
    #private;
    handleEvent([eventName, payload]: Event): void;
}

declare abstract class Reporter implements EventHandler {
    protected outputService: OutputService;
    constructor(outputService: OutputService);
    abstract handleEvent([eventName, payload]: Event): void;
}

declare class RunReporter extends Reporter implements EventHandler {
    #private;
    constructor(resolvedConfig: ResolvedConfig, outputService: OutputService);
    handleEvent([eventName, payload]: Event): void;
}

declare class SetupReporter extends Reporter implements EventHandler {
    handleEvent([eventName, payload]: Event): void;
}

declare class SummaryReporter extends Reporter implements EventHandler {
    handleEvent([eventName, payload]: Event): void;
}

declare class WatchReporter extends Reporter implements EventHandler {
    handleEvent([eventName, payload]: Event): void;
}

type InputHandler = (chunk: string) => void;
declare class InputService {
    #private;
    constructor(onInput: InputHandler);
    close(): void;
}

declare class Path {
    static normalizeSlashes: (filePath: string) => string;
    static dirname(filePath: string): string;
    static join(...filePaths: Array<string>): string;
    static relative(from: string, to: string): string;
    static resolve(...filePaths: Array<string>): string;
}

declare class ProjectService {
    #private;
    constructor(compiler: typeof ts);
    closeFile(filePath: string): void;
    getDefaultProject(filePath: string): ts.server.Project | undefined;
    getLanguageService(filePath: string): ts.LanguageService | undefined;
    openFile(filePath: string, sourceText?: string | undefined, projectRootPath?: string | undefined): void;
}

declare class Runner {
    #private;
    constructor(resolvedConfig: ResolvedConfig, selectService: SelectService, storeService: StoreService);
    close(): void;
    run(tasks: Array<Task>, cancellationToken?: CancellationToken): Promise<void>;
}

declare class Version {
    #private;
    static isGreaterThan(source: string, target: string): boolean;
    static isSatisfiedWith(source: string, target: string): boolean;
    static isVersionTag(target: string): boolean;
}

type WatchHandler = (filePath: string) => void;
interface WatcherOptions {
    recursive?: boolean;
}
declare class Watcher {
    #private;
    constructor(targetPath: string, onChanged: WatchHandler, onRemoved?: WatchHandler, options?: WatcherOptions);
    close(): void;
    watch(): void;
}

type FileWatchHandler = () => void;
declare class FileWatcher extends Watcher {
    constructor(targetPath: string, onChanged: FileWatchHandler);
}

declare class WatchService {
    #private;
    constructor(resolvedConfig: ResolvedConfig, selectService: SelectService, tasks: Array<Task>);
    watch(cancellationToken: CancellationToken): AsyncIterable<Array<Task>>;
}

export { Assertion, CancellationHandler, CancellationReason, CancellationToken, Cli, CollectService, Color, type CommandLineOptions, ConfigDiagnosticText, type ConfigFileOptions, ConfigService, DescribeResult, Diagnostic, DiagnosticCategory, DiagnosticOrigin, type Event, EventEmitter, type EventHandler, ExitCodeHandler, ExpectResult, ExpectService, type FileWatchHandler, FileWatcher, type InputHandler, InputService, type ItemDefinition, Line, type MatchResult, OptionBrand, type OptionDefinition, OptionDefinitionsMap, OptionGroup, OutputService, Path, ProjectResult, ProjectService, type ResolvedConfig, Result, ResultCount, ResultHandler, ResultStatus, ResultTiming, RunReporter, Runner, Scribbler, ScribblerJsx, type ScribblerOptions, SelectDiagnosticText, SelectService, SetupReporter, SourceFile, StoreService, SummaryReporter, TSTyche, TargetResult, type TargetResultStatus, Task, TaskResult, type TaskResultStatus, TestMember, TestMemberBrand, TestMemberFlags, TestResult, TestTree, Text, type TypeChecker, Version, type WatchHandler, WatchReporter, WatchService, Watcher, type WatcherOptions, addsPackageText, defaultOptions, describeNameText, diagnosticText, environmentOptions, fileViewText, formattedText, helpText, summaryText, taskStatusText, testNameText, usesCompilerText, waitingForFileChangesText, watchUsageText };
