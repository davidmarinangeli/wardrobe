// The control panel: sections in a left rail, one column of settings.
// Every value it shows comes from Rust commands (src/api.js); secrets come
// back only as { present, hint }.
import { useCallback, useEffect, useState } from "react";
import * as api from "./api.js";
import { useServerState } from "./hooks.js";
import { AiSection } from "./sections/AiSection.jsx";
import { DriveSection } from "./sections/DriveSection.jsx";
import { GeneralSection, PlaceholderSection } from "./sections/GeneralSection.jsx";
import { StatusSection } from "./sections/StatusSection.jsx";
import { StorageSection } from "./sections/StorageSection.jsx";
import { stateLabel } from "./validation.js";

export const SECTIONS = [
  { id: "status", label: "Status" },
  { id: "ai", label: "AI provider" },
  { id: "storage", label: "Storage" },
  { id: "drive", label: "Google Drive" },
  { id: "general", label: "General" },
  { id: "remote", label: "Remote access" },
  { id: "updates", label: "Updates" },
];

export function App() {
  const server = useServerState();
  const [info, setInfo] = useState(null);
  const [config, setConfig] = useState(null);
  const [secrets, setSecrets] = useState(null);
  const [section, setSection] = useState(null);
  const [loadError, setLoadError] = useState("");

  const refreshConfig = useCallback(() => api.getConfig().then(setConfig), []);
  const refreshSecrets = useCallback(async () => {
    const [nextSecrets, nextInfo] = await Promise.all([api.secretStatus(), api.appInfo()]);
    setSecrets(nextSecrets);
    setInfo(nextInfo);
  }, []);

  useEffect(() => {
    Promise.all([api.appInfo(), api.getConfig(), api.secretStatus()])
      .then(([nextInfo, nextConfig, nextSecrets]) => {
        setInfo(nextInfo);
        setConfig(nextConfig);
        setSecrets(nextSecrets);
        // First launch: no key yet, so the AI screen comes first.
        setSection((current) => current ?? (nextInfo.has_provider_key ? "status" : "ai"));
      })
      .catch((error) => { setLoadError(api.errorText(error)); setSection((current) => current ?? "status"); });
  }, []);

  // Every change that affects the server ends in a restart, so a state change
  // is the moment to re-read what the panel shows (also covers changes made
  // from the tray or another control window).
  useEffect(() => {
    if (!server) return;
    Promise.all([api.appInfo(), api.getConfig(), api.secretStatus()])
      .then(([nextInfo, nextConfig, nextSecrets]) => { setInfo(nextInfo); setConfig(nextConfig); setSecrets(nextSecrets); })
      .catch(() => {});
  }, [server?.state, server?.port]);

  const firstLaunch = Boolean(info && !info.has_provider_key);
  const props = {
    server, info, config, secrets,
    onConfigChanged: refreshConfig,
    onSecretsChanged: refreshSecrets,
  };

  return (
    <div className="layout">
      <nav className="rail" aria-label="Settings sections">
        <div className="rail__brand">
          <strong>Wardrobe</strong>
          <span className="muted">{info ? `Version ${info.version}` : ""}</span>
        </div>
        <ul>
          {SECTIONS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`rail__item${section === item.id ? " is-active" : ""}`}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                {item.label}
                {item.id === "ai" && firstLaunch && <span className="badge" aria-label="needs a key">!</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className={`rail__status status-${server?.state || "unknown"}`} aria-live="polite">{stateLabel(server)}</p>
      </nav>
      <main className="content">
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {section === "status" && <StatusSection {...props} />}
        {section === "ai" && <AiSection {...props} firstLaunch={firstLaunch} />}
        {section === "storage" && <StorageSection {...props} />}
        {section === "drive" && <DriveSection {...props} />}
        {section === "general" && <GeneralSection {...props} />}
        {section === "remote" && <PlaceholderSection id="remote" title="Remote access" />}
        {section === "updates" && <PlaceholderSection id="updates" title="Updates" />}
      </main>
    </div>
  );
}
