import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure } from "./errors.ts";

export type CommandOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
};

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  exec(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

export class PiCommandRunner implements CommandRunner {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  async exec(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return this.pi.exec(command, [...args], options);
  }
}

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  const result = await runner.exec(command, args, options);
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim();
    throw new RuntimeFailure(
      `command failed (${String(result.code)}): ${[command, ...args].join(" ")}` +
        (output ? `\n${output}` : ""),
    );
  }
  return result.stdout.trim();
}
