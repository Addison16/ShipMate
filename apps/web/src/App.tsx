import { AppearanceProvider } from "./appearance.js";
import { AuthProvider, useAuth } from "./auth.js";
import { Shell } from "./components/Shell.js";
import { Button } from "./components/ui.js";
import { LoginPage } from "./pages/Login.js";
import { OnboardingPage } from "./pages/Onboarding.js";
import { WelcomePage } from "./pages/Welcome.js";

function Gate() {
  const { loading, error, user, setupRequired, onboarding, refresh } = useAuth();
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
  // First launch: the owner account, then the guide until the owner finishes or skips it.
  if (setupRequired || (user?.role === "owner" && onboarding?.pending)) return <OnboardingPage />;
  if (!user) return <LoginPage />;
  if (user.welcomePending) return <WelcomePage />;
  return <Shell />;
}

export function App() {
  return (
    <AuthProvider>
      <AppearanceProvider>
        <Gate />
      </AppearanceProvider>
    </AuthProvider>
  );
}
