import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import { AuthLayout } from "../components/AuthLayout.js";
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
      navigate("/bridge");
      setUser(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
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
