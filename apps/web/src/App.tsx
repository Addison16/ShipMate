import { AppearanceProvider } from "./appearance.js";
import { AuthProvider, useAuth } from "./auth.js";
import { Shell } from "./components/Shell.js";
import { Button } from "./components/ui.js";
import { sharedToken } from "./lib/share.js";
import { LoginPage } from "./pages/Login.js";
import { OnboardingPage } from "./pages/Onboarding.js";
import { SharedChatPage } from "./pages/SharedChat.js";
import { WelcomePage } from "./pages/Welcome.js";
import { useRoute } from "./router.js";

function Gate() {
  const { loading, error, user, setupRequired, onboarding, refresh } = useAuth();
  // A shared chat's link opens for anyone, signed in or not.
  useRoute();
  const shared = sharedToken(window.location.hash);
  if (shared) return <SharedChatPage token={shared} />;
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
