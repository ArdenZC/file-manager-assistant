import { AppRuntimeProviders } from "./components/AppRuntimeProviders";
import { AppShell } from "./components/AppShell";
import { DatabaseBootstrapper } from "./components/DatabaseBootstrapper";

export function App() {
  return (
    <DatabaseBootstrapper>
      <AppRuntimeProviders>
        <AppShell />
      </AppRuntimeProviders>
    </DatabaseBootstrapper>
  );
}
