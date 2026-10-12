import type { HouseholdDto, ProfileDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import { USE_CHOICES } from "../lib/onboarding.js";
import { browserTimeZone } from "../lib/starters.js";
import { useResource } from "../lib/useResource.js";
import { Button, Card, ErrorText, Muted, SelectField, TextAreaField, TextField } from "./ui.js";

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
  ) : null;
}

/**
 * Household profiles: what every crew member should know about you and the household, so
 * nobody has to tell each bot their diet or timezone again.
 */
export function ProfileSettings() {
  const data = useResource(() => api.getProfile());
  return (
    <>
      <ErrorText>{data.error}</ErrorText>
      {data.loading && !data.data && <Muted>Loading…</Muted>}
      {data.data && (
        <>
          <MyProfile initial={data.data.profile} />
          <Household initial={data.data.household} />
        </>
      )}
    </>
  );
}

function MyProfile({ initial }: { initial: ProfileDto }) {
  const [p, setP] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ProfileDto>(k: K, v: ProfileDto[K]) => {
    setP((s) => ({ ...s, [k]: v }));
    setSaved(false);
  };
  const tz = browserTimeZone();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { profile } = await api.updateProfile({
        diet: p.diet,
        budget: p.budget,
        timezone: p.timezone.trim(),
        schedule: p.schedule,
        notes: p.notes,
        shared: p.shared,
      });
      setP(profile);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Your profile</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Every crew member reads this when working for you, so you never have to repeat it.
      </p>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Diet and allergies"
            placeholder="e.g. vegetarian, no peanuts"
            maxLength={500}
            value={p.diet}
            onChange={(e) => set("diet", e.target.value)}
          />
          <TextField
            label="Budget"
            placeholder="e.g. groceries about $150 a week"
            maxLength={500}
            value={p.budget}
            onChange={(e) => set("budget", e.target.value)}
          />
        </div>
        <TextField
          label="Timezone"
          placeholder={tz ?? "e.g. Europe/Berlin"}
          maxLength={64}
          hint={
            tz && p.timezone !== tz ? (
              <button
                type="button"
                className="text-accent-700 hover:underline dark:text-accent-300"
                onClick={() => set("timezone", tz)}
              >
                Use this device's timezone ({tz})
              </button>
            ) : (
              "An IANA name; crew use it for times and reminders."
            )
          }
          value={p.timezone}
          onChange={(e) => set("timezone", e.target.value)}
        />
        <TextAreaField
          label="Schedule"
          rows={3}
          maxLength={2000}
          placeholder="Work hours, routines, the kids' school and activities"
          value={p.schedule}
          onChange={(e) => set("schedule", e.target.value)}
        />
        <TextAreaField
          label="Anything else"
          rows={3}
          maxLength={2000}
          placeholder="Preferences the crew should know: favorite stores, how you like replies, …"
          value={p.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.shared}
            onChange={(e) => set("shared", e.target.checked)}
            className="mt-0.5 size-4 accent-accent-700"
          />
          <span>
            Share with the household: crew working for others may read it too (say, the Galley
            planning dinner for everyone).
          </span>
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </Button>
          <Saved show={saved} />
        </div>
      </form>
    </Card>
  );
}

function Household({ initial }: { initial: HouseholdDto }) {
  const user = useUser();
  const canEdit = isAdmin(user);
  const [h, setH] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setH(initial), [initial]);
  const set = <K extends keyof HouseholdDto>(k: K, v: HouseholdDto[K]) => {
    setH((s) => ({ ...s, [k]: v }));
    setSaved(false);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { household } = await api.updateHousehold({
        use: h.use,
        location: h.location,
        timezone: h.timezone.trim(),
        notes: h.notes,
      });
      setH(household);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Household</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Shared facts every crew member knows.{" "}
        {canEdit ? "Everyone can read them." : "Only owners and admins can change them."}
      </p>
      <form onSubmit={save} className="space-y-4">
        <SelectField
          label="Shipmate is for"
          className="max-w-sm"
          hint="Tells the crew what kind of help to expect."
          disabled={!canEdit}
          value={h.use}
          onChange={(e) => set("use", e.target.value as HouseholdDto["use"])}
        >
          <option value="">Not set</option>
          {USE_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Home location"
            placeholder="e.g. Austin, TX"
            hint="Used for the weather and travel."
            maxLength={200}
            disabled={!canEdit}
            value={h.location}
            onChange={(e) => set("location", e.target.value)}
          />
          <TextField
            label="Household timezone"
            placeholder="e.g. America/Chicago"
            maxLength={64}
            disabled={!canEdit}
            value={h.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </div>
        <TextAreaField
          label="Household facts"
          rows={4}
          maxLength={4000}
          disabled={!canEdit}
          placeholder="Who lives here, kids' ages and schedules, pets, shared routines, house rules"
          value={h.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save household"}
            </Button>
            <Saved show={saved} />
          </div>
        )}
      </form>
    </Card>
  );
}
