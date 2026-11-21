import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * A program in a pseudo-terminal, without a native Node module: Python's `pty` module (python3
 * ships in the Shipmate image) forks the program on a new terminal and relays bytes. Some CLIs
 * (the Gemini CLI's Google sign-in, any shell) only work on a real terminal.
 *
 * The relay reads the program's input on stdin and new sizes ("rows cols" lines) on fd 3, and
 * writes the terminal's output to stdout. It exits with the program's exit code. When stdin
 * closes it hangs the program up.
 */
const RELAY = `
import os, pty, sys, select, signal, struct, fcntl, termios
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write("could not start %s: %s\\n" % (argv[0], e))
        os._exit(127)
def size(rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
size(int(os.environ.get("SHIPMATE_PTY_ROWS", "30")), int(os.environ.get("SHIPMATE_PTY_COLS", "100")))
inputs = [fd, 0, 3]
ctl = b""
def write_all(data):
    while data:
        n = os.write(fd, data)
        data = data[n:]
while True:
    try:
        ready, _, _ = select.select(inputs, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            try:
                os.kill(pid, signal.SIGHUP)
            except Exception:
                pass
            inputs.remove(0)
        else:
            try:
                write_all(data)
            except OSError:
                break
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            inputs.remove(3)
        else:
            ctl += data
            while b"\\n" in ctl:
                line, ctl = ctl.split(b"\\n", 1)
                parts = line.split()
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    size(max(2, min(500, int(parts[0]))), max(10, min(1000, int(parts[1]))))
try:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except Exception:
    code = 1
sys.exit(code if code >= 0 else 128 - code)
`;

export interface Pty {
  /** Send keys (as typed: "\r" is Enter). */
  write(data: string): void;
  resize(rows: number, cols: number): void;
  /** Hang up, then force it closed shortly after. */
  kill(): void;
  readonly pid: number | undefined;
}

export interface PtyOptions {
  command: string;
  args?: string[];
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
  rows?: number;
  cols?: number;
  onData: (text: string) => void;
  onExit: (code: number | null) => void;
  /** The relay itself could not start (no python3). */
  onError?: (err: Error) => void;
  /** For tests. */
  python?: string;
}

export function pythonBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_PYTHON?.trim() || "python3";
}

export function spawnPty(o: PtyOptions): Pty {
  const decoder = new StringDecoder("utf8");
  let child: ChildProcess;
  let exited = false;
  const env: NodeJS.ProcessEnv = {
    TERM: "xterm-256color",
    ...o.env,
    SHIPMATE_PTY_ROWS: String(o.rows ?? 30),
    SHIPMATE_PTY_COLS: String(o.cols ?? 100),
  };
  try {
    child = spawn(o.python ?? pythonBin(), ["-c", RELAY, o.command, ...(o.args ?? [])], {
      cwd: o.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
  } catch (err) {
    queueMicrotask(() => o.onError?.(err as Error));
    return { write() {}, resize() {}, kill() {}, pid: undefined };
  }
  child.stdout?.on("data", (b: Buffer) => o.onData(decoder.write(b)));
  child.stderr?.on("data", (b: Buffer) => o.onData(decoder.write(b)));
  child.stdin?.on("error", () => {});
  const ctl = child.stdio[3] as NodeJS.WritableStream | null;
  ctl?.on("error", () => {});
  child.on("error", (err) => {
    if (exited) return;
    exited = true;
    o.onError?.(err);
  });
  child.on("close", (code) => {
    if (exited) return;
    exited = true;
    const rest = decoder.end();
    if (rest) o.onData(rest);
    o.onExit(code);
  });
  return {
    pid: child.pid,
    write(data) {
      if (!exited) child.stdin?.write(data);
    },
    resize(rows, cols) {
      if (!exited && Number.isFinite(rows) && Number.isFinite(cols)) {
        ctl?.write(`${Math.round(rows)} ${Math.round(cols)}\n`);
      }
    },
    kill() {
      if (exited) return;
      child.stdin?.end();
      const force = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 3_000);
      force.unref?.();
    },
  };
}

/** Terminal output as plain text: colors and cursor moves removed, carriage returns as new lines. */
export function plainText(text: string): string {
  return (
    text
      // OSC (titles, links): ESC ] ... BEL or ESC \
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI: ESC [ params final
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
      .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, "")
      // Other two-byte escapes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
      .replace(/\x1b[@-Z\\-_]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: leftover control characters
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(/\n{3,}/g, "\n\n")
  );
}
