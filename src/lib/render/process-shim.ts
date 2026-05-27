type ProcessEnv = Record<string, string | undefined>;

type ProcessLike = {
  env: ProcessEnv;
  versions: Record<string, string | undefined>;
  version: string;
  release: { name?: string };
  emitWarning: (...args: unknown[]) => void;
  exit: (code?: number) => never;
};

const globalScope = globalThis as Record<string, unknown>;

const processRef = ((globalScope.process as ProcessLike | undefined) ??= {
  env: {},
  versions: { node: "22.0.0" },
  version: "v22.0.0",
  release: { name: "node" },
  emitWarning: () => undefined,
  exit: (code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) is not supported in this runtime`);
  },
} satisfies ProcessLike);

processRef.env ??= {};
processRef.versions ??= { node: "22.0.0" };
processRef.version ??= "v22.0.0";
processRef.release ??= { name: "node" };
processRef.emitWarning ??= () => undefined;
processRef.exit ??= (code?: number) => {
  throw new Error(`process.exit(${code ?? 0}) is not supported in this runtime`);
};

export const env = processRef.env;
export const versions = processRef.versions;
export const version = processRef.version;
export const release = processRef.release;
export const emitWarning = processRef.emitWarning;
export const exit = processRef.exit;

export default processRef;