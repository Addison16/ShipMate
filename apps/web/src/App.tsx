import { AuthProvider, useAuth } from "./auth.js";
import { Shell } from "./components/Shell.js";
import { Button } from "./components/ui.js";
import { LoginPage } from "./pages/Login.js";
import { SetupPage } from "./pages/Setup.js";

function Gate() {
  const { loading, error, user, setupRequired, refresh } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-slate-500">Connecting…</div>
    );
  }
  if (error && !user) {
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <div className="max-w-sm space-y-3 text-center">
          <p className="font-medium">Cannot reach the Shipmate server.</p>
          <p className="text-sm text-slate-500">{error}</p>
          <Button variant="primary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (setupRequired) return <SetupPage />;
  if (!user) return <LoginPage />;
  return <Shell />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
