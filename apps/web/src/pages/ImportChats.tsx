import { useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { Button, Card, ErrorText, Notice, Page, PageHeader } from "../components/ui.js";
import { type ParsedExport, readExportFile, sendExport } from "../lib/chat-import.js";
import { href } from "../router.js";

const NAMES = { chatgpt: "ChatGPT", claude: "Claude" } as const;

type Step =
  | { at: "pick" }
  | { at: "reading"; name: string }
  | { at: "ready"; name: string; parsed: ParsedExport }
  | { at: "sending"; parsed: ParsedExport; done: number }
  | { at: "done"; source: keyof typeof NAMES; imported: number; skipped: number; stopped: boolean };

/** Settings → Import chats: bring a ChatGPT or Claude export into your own chat list. */
export function ImportChatsPage() {
  const picker = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [step, setStep] = useState<Step>({ at: "pick" });
  const [archive, setArchive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    setError(null);
    setStep({ at: "reading", name: file.name });
    try {
      const parsed = await readExportFile(file);
      if (!parsed.chats.length) throw new Error("There are no chats in this file.");
      setStep({ at: "ready", name: file.name, parsed });
    } catch (err) {
      setError(errorMessage(err));
      setStep({ at: "pick" });
    }
  }

  async function send(parsed: ParsedExport) {
    setError(null);
    stop.current = false;
    setStep({ at: "sending", parsed, done: 0 });
    try {
      const r = await sendExport(parsed, {
        archive,
        onProgress: (done) => setStep({ at: "sending", parsed, done }),
        stopped: () => stop.current,
      });
      setStep({ at: "done", source: parsed.source, ...r, stopped: stop.current });
    } catch (err) {
      // What was sent so far is kept; importing the same file again only adds the rest.
      setError(`${errorMessage(err)} Chats sent so far were kept. Pick the file again to finish.`);
      setStep({ at: "pick" });
    }
  }

  return (
    <Page>
      <PageHeader
        title="Import chats"
        description="Bring your chats over from ChatGPT or Claude. Only you see them."
      />
      <div className="space-y-6">
        <ErrorText>{error}</ErrorText>
        <input
          ref={picker}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void read(file);
          }}
        />

        {(step.at === "pick" || step.at === "reading") && (
          <Card>
            <div className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>Ask ChatGPT or Claude for an export of your data.</li>
                <li>Download the .zip file from the email they send.</li>
                <li>Pick that file here.</li>
              </ol>
              <Button
                variant="primary"
                disabled={step.at === "reading"}
                onClick={() => picker.current?.click()}
              >
                {step.at === "reading" ? `Reading ${step.name}…` : "Pick export file"}
              </Button>
              <details className="text-sm text-slate-500 dark:text-slate-400">
                <summary className="cursor-pointer">More details</summary>
                <div className="mt-2 space-y-2">
                  <p>
                    ChatGPT: Settings → Data controls → Export data. Claude: Settings → Privacy →
                    Export data. Both send an email with a download link, which can take a while.
                  </p>
                  <p>
                    The file is read on this device and only the words of each chat are sent to your
                    Shipmate. Pictures, files and voice recordings are left out. If a very large
                    export will not open on a phone, try a computer, or unzip it and pick
                    conversations.json.
                  </p>
                  <p>
                    Importing the same file again adds nothing twice. Your agents were not part of
                    these chats, so when you carry one on, the agent is shown the last part of it.
                  </p>
                </div>
              </details>
            </div>
          </Card>
        )}

        {step.at === "ready" && (
          <Card>
            <div className="space-y-4">
              <p className="text-sm">
                Found <strong>{count(step.parsed.chats.length)}</strong> from{" "}
                {NAMES[step.parsed.source]} in {step.name}.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-accent-600"
                  checked={archive}
                  onChange={(e) => setArchive(e.target.checked)}
                />
                <span>
                  Put them under Archived
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    Keeps your chat list tidy. Search still finds them.
                  </span>
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void send(step.parsed)}>
                  Import {count(step.parsed.chats.length)}
                </Button>
                <Button variant="ghost" onClick={() => setStep({ at: "pick" })}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        {step.at === "sending" && (
          <Card>
            <div className="space-y-3">
              <p className="text-sm" aria-live="polite">
                Importing… {step.done} of {step.parsed.chats.length}
              </p>
              <div
                className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={step.parsed.chats.length}
                aria-valuenow={step.done}
              >
                <div
                  className="h-full rounded-full bg-accent-600 transition-all duration-300"
                  style={{ width: `${(step.done / step.parsed.chats.length) * 100}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Keep this page open.</p>
              <Button
                variant="ghost"
                onClick={() => {
                  stop.current = true;
                }}
              >
                Stop
              </Button>
            </div>
          </Card>
        )}

        {step.at === "done" && (
          <Card>
            <div className="space-y-4">
              <Notice>
                {step.stopped ? "Stopped. " : ""}
                Imported {count(step.imported)} from {NAMES[step.source]}.
                {step.skipped > 0 &&
                  ` ${step.skipped} ${step.skipped === 1 ? "was" : "were"} skipped (already here, or empty).`}
              </Notice>
              <div className="flex flex-wrap gap-2">
                <a
                  href={href("/bridge")}
                  className="inline-flex items-center rounded-md bg-accent-700 px-3 py-2 text-sm font-medium text-white hover:bg-accent-800"
                >
                  Go to chats
                </a>
                <Button variant="ghost" onClick={() => setStep({ at: "pick" })}>
                  Import another file
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}

const count = (n: number) => `${n} chat${n === 1 ? "" : "s"}`;
