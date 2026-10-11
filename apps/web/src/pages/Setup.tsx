import type { InstallStartersResponse, UserDto } from "@shipmate/core";
import type { UserDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import { AuthLayout } from "../components/AuthLayout.js";
import { StarterCrewPicker } from "../components/StarterCrewPicker.js";
import { Button, ErrorText, Notice, TextField } from "../components/ui.js";
import { LocalAiCard } from "../components/LocalAiCard.js";
import { Button, ErrorText, TextField } from "../components/ui.js";
import { navigate } from "../router.js";

export function SetupPage() {
  const { setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [captainName, setCaptainName] = useState("Captain");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Step 2: the owner account exists (and is signed in); offer starter crew before going aboard.
  const [owner, setOwner] = useState<UserDto | null>(null);
  const [result, setResult] = useState<InstallStartersResponse | null>(null);

  function goAboard() {
    if (!owner) return;
    navigate("/bridge");
    setUser(owner);
  }

  if (owner && result) {
    return (
      <AuthLayout title="Crew aboard" subtitle="Your starter crew is ready.">
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {result.crew.map((c) => (
              <li key={c.slug}>
                <strong>{c.name}</strong>: {c.role}
              </li>
            ))}
          </ul>
          {result.notes.map((n) => (
            <Notice key={n}>{n}</Notice>
          ))}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Next, add a model provider under Providers so the crew can answer.
          </p>
          <Button variant="primary" className="w-full" onClick={goAboard}>
            Go to the Bridge
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (owner) {
    return (
      <AuthLayout
        title="Pick a starter crew"
        subtitle="Ready-made crew members, each with a persona and the tools they need. You can edit, add or retire crew any time on the Crew page."
      >
        <StarterCrewPicker
          doneLabel="Bring aboard"
          onDone={setResult}
          skipLabel="Skip for now"
          onSkip={goAboard}
        />
      </AuthLayout>
    );
  }
  // Step 2: the owner exists and is signed in; offer a local model before entering the app.
  const [owner, setOwner] = useState<UserDto | null>(null);
  const [modelRef, setModelRef] = useState<string | null>(null);

  const enter = () => {
    if (!owner) return;
    navigate("/bridge");
    setUser(owner);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = captainName.trim();
      const { user } = await api.setup({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        ...(name && name !== "Captain" ? { captainName: name } : {}),
      });
      setOwner(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (owner) {
    return (
      <AuthLayout
        title="Pick a model"
        subtitle="The crew needs a model to think with. Run one locally with Ollama, no API key needed, or skip this and add a provider (an API key or a subscription sign-in) on the Providers page."
      >
        <div className="space-y-4">
          <LocalAiCard heading={false} onUsed={setModelRef} />
          <Button variant={modelRef ? "primary" : "secondary"} className="w-full" onClick={enter}>
            {modelRef ? "Go to the Bridge" : "Skip for now"}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Welcome aboard"
      subtitle="Create the owner account for this Shipmate instance. You can invite others later."
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Display name"
          autoComplete="name"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <TextField
          label="Coordinator name"
          hint="The crew member who runs the Bridge and delegates to the others. You can rename it later."
          value={captainName}
          onChange={(e) => setCaptainName(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Setting up…" : "Create owner account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
