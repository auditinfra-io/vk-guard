import ts from 'typescript';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { projectModuleType } from './project.js';

export type BuildResult = {
  /** Absolute source path -> absolute emitted .js path. */
  outputs: Map<string, string>;
  semanticErrorCount: number;
};

/**
 * Compile the project's TypeScript sources with the real TypeScript compiler.
 *
 * This step is not optional and cannot be swapped for a faster esbuild-based
 * loader (tsx, ts-node/swc in transpile mode). o1js's `@method` decorator reads
 * parameter types at runtime via `design:paramtypes`, which is only emitted by
 * `emitDecoratorMetadata` — a feature esbuild does not implement. Loading
 * contracts through esbuild fails with a confusing
 * "Cannot read properties of undefined (reading 'map')" inside
 * `sortMethodArguments`, because the decorator never received its argument types.
 */
export function buildProject(
  root: string,
  entries: string[],
  outDir: string,
  tsconfigPath: string | undefined
): BuildResult {
  const options = loadCompilerOptions(root, tsconfigPath);

  const compilerOptions: ts.CompilerOptions = {
    ...options,
    outDir,
    rootDir: root,
    noEmit: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    incremental: false,
    composite: false,
    // o1js contracts require both; default them on when the project is silent.
    experimentalDecorators: options.experimentalDecorators ?? true,
    emitDecoratorMetadata: options.emitDecoratorMetadata ?? true,
    // Class fields must be assigned, not defined, for `@state` to work.
    useDefineForClassFields: options.useDefineForClassFields ?? false,
  };

  const program = ts.createProgram(entries, compilerOptions);

  // Record the emitted path for every source file directly from the emit
  // callback. Deriving it instead (via getOutputFileNames or by string
  // surgery on outDir/rootDir) is guesswork that breaks on .mts/.cts and on
  // projects whose rootDir differs from ours.
  const emittedFor = new Map<string, string>();
  const emitResult = program.emit(
    undefined,
    (fileName, text, writeByteOrderMark, _onError, sourceFiles) => {
      mkdirSync(dirname(fileName), { recursive: true });
      writeFileSync(fileName, writeByteOrderMark ? '\uFEFF' + text : text, 'utf8');
      if (!/\.(js|mjs|cjs)$/.test(fileName)) return;
      for (const sf of sourceFiles ?? []) emittedFor.set(resolve(sf.fileName), fileName);
    }
  );

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...emitResult.diagnostics,
  ];
  const fatal = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    throw new Error(`TypeScript could not build the project:\n${formatDiagnostics(fatal, root)}`);
  }

  // Semantic (type) errors do not block emit. We surface the count rather than
  // aborting, because measurement only needs valid JS — but we never hide them.
  const semanticErrorCount = program
    .getSemanticDiagnostics()
    .filter((d) => d.category === ts.DiagnosticCategory.Error).length;

  mkdirSync(outDir, { recursive: true });
  // A nested package.json pins how Node interprets the emitted files, which
  // otherwise depends on where outDir happens to sit relative to the project.
  const moduleType =
    compilerOptions.module === ts.ModuleKind.CommonJS ? 'commonjs' : projectModuleType(root);
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: moduleType }) + '\n', 'utf8');

  const outputs = new Map<string, string>();
  for (const entry of entries) {
    const abs = resolve(entry);
    const emitted = emittedFor.get(abs);
    if (emitted && existsSync(emitted)) outputs.set(abs, emitted);
  }
  return { outputs, semanticErrorCount };
}

function loadCompilerOptions(root: string, tsconfigPath: string | undefined): ts.CompilerOptions {
  const configPath =
    tsconfigPath ?? ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ?? undefined;
  if (!configPath) return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext };

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(`could not read ${configPath}: ${formatDiagnostics([read.error], root)}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  return parsed.options;
}

function formatDiagnostics(diags: readonly ts.Diagnostic[], root: string): string {
  return ts.formatDiagnostics(diags, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  });
}
