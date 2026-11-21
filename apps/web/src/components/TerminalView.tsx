import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { terminalSocketUrl } from "../lib/cli-login.js";
import { Button, cx, focusRing } from "./ui.js";

/** Keys phone keyboards don't have. */
const KEYS: Array<{ label: string; aria: string; send: string }> = [
  { label: "Esc", aria: "Escape", send: "\x1b" },
  { label: "Tab", aria: "Tab", send: "\t" },
  { label: "Ctrl-C", aria: "Control C", send: "\x03" },
  { label: "Ctrl-D", aria: "Control D", send: "\x04" },
  { label: "←", aria: "Left", send: "\x1b[D" },
  { label: "↑", aria: "Up", send: "\x1b[A" },
  { label: "↓", aria: "Down", send: "\x1b[B" },
  { label: "→", aria: "Right", send: "\x1b[C" },
];

/** A shell on the server in the page (Settings > Terminal), over the owner-only socket. */
export default function TerminalView({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<Terminal | null>(null);
  const [ended, setEnded] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: { background: "#0b1220", foreground: "#e2e8f0", cursor: "#e2e8f0" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    fit.fit();
    term.current = t;
    const ws = new WebSocket(terminalSocketUrl(window.location, t.rows, t.cols));
    socket.current = ws;
    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (ev) => {
      let msg: { t: string; d?: string; message?: string; code?: number | null };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "o" && msg.d) t.write(msg.d);
      else if (msg.t === "x") setEnded(msg.message ?? "The terminal closed.");
      else if (msg.t === "e") setEnded("The shell ended.");
    };
    ws.onclose = () => setEnded((e) => e ?? "The terminal closed.");
    const input = t.onData((d) => send({ t: "i", d }));
    const resize = t.onResize(({ rows, cols }) => send({ t: "r", rows, cols }));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    observer.observe(el);
    t.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      ws.close();
      t.dispose();
    };
  }, []);

  const key = (send: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d: send }));
    term.current?.focus();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Extra keys">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            aria-label={k.aria}
            onClick={() => key(k.send)}
            className={cx(
              "min-h-9 min-w-10 rounded-md border border-slate-300 bg-white px-2 font-mono text-xs text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
              focusRing,
            )}
          >
            {k.label}
          </button>
        ))}
      </div>
      {/* Above the keys' row on phones the keyboard covers the bottom of the page. */}
      <div
        ref={box}
        className="h-[55vh] min-h-64 w-full overflow-hidden rounded-lg bg-[#0b1220] p-2"
      />
      <div className="flex flex-wrap items-center gap-2">
        {ended && <p className="text-sm text-slate-600 dark:text-slate-300">{ended}</p>}
        <Button size="sm" onClick={onClose}>
          Close terminal
        </Button>
      </div>
    </div>
  );
}
