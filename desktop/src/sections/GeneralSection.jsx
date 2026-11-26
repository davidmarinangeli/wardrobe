import { useEffect, useState } from "react";
import * as api from "../api.js";
import { ErrorText, Section } from "../components.jsx";
import { useAction } from "../hooks.js";

export function GeneralSection({ config, info, onConfigChanged }) {
  const [autostart, setAutostart] = useState(null);
  const { pending, error, run } = useAction();
  useEffect(() => { api.autostartGet().then(setAutostart, () => setAutostart(null)); }, []);
  const settings = config?.config;

  const patch = (label, value) => run(label, async () => {
    await api.setConfig(value);
    await onConfigChanged();
  });

  return (
    <Section id="general" title="General">
      <div className="card">
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(autostart)}
            disabled={autostart === null || Boolean(pending)}
            onChange={(event) => run("autostart", async () => setAutostart(await api.autostartSet(event.target.checked)))}
          />
          Launch Wardrobe at login
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(settings?.start_hidden)}
            disabled={!settings || Boolean(pending)}
            onChange={(event) => patch("hidden", { start_hidden: event.target.checked })}
          />
          Start hidden in the {info?.platform === "macos" ? "menu bar" : "tray"}
        </label>
        <fieldset className="choice">
          <legend>At launch, open Wardrobe in</legend>
          {[["window", "The app window"], ["browser", "The default browser"]].map(([value, label]) => (
            <label key={value} className="check">
              <input
                type="radio"
                name="open-wardrobe-in"
                value={value}
                checked={(settings?.open_wardrobe_in ?? "window") === value}
                disabled={!settings || Boolean(pending)}
                onChange={() => patch("open", { open_wardrobe_in: value })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <ErrorText>{error}</ErrorText>
      </div>
    </Section>
  );
}

export function PlaceholderSection({ id, title }) {
  return (
    <Section id={id} title={title}>
      <p className="muted">Coming in a later version.</p>
    </Section>
  );
}
