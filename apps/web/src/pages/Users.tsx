import type { UserDto, UserRole } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Page,
  PageHeader,
  SelectField,
  Table,
  TextField,
  td,
  th,
} from "../components/ui.js";
import { dollarsToCents, formatCents } from "../lib/format.js";
import { useResource } from "../lib/useResource.js";

export function UsersPage() {
  const me = useUser();
  const owner = me.role === "owner";
  const users = useResource(() => api.listUsers().then((r) => r.users));
  const [error, setError] = useState<string | null>(null);

  function replace(u: UserDto) {
    users.setData((users.data ?? []).map((x) => (x.id === u.id ? u : x)));
  }

  async function update(id: string, body: Parameters<typeof api.updateUser>[1]) {
    setError(null);
    try {
      const { user } = await api.updateUser(id, body);
      replace(user);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  async function remove(u: UserDto) {
    if (!window.confirm(`Delete ${u.displayName} (${u.email})? Their conversations go too.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteUser(u.id);
      users.setData((users.data ?? []).filter((x) => x.id !== u.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Page wide>
      <PageHeader
        title="Users"
        description="Everyone shares the same crew and providers; each person has their own conversations."
      />
      <ErrorText>{users.error ?? error}</ErrorText>
      {users.data && (
        <Table>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Email</th>
              <th className={th}>Role</th>
              <th className={th}>Monthly cap</th>
              <th className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td className={td}>
                  {u.displayName}
                  {u.id === me.id && (
                    <span className="ml-2">
                      <Badge>you</Badge>
                    </span>
                  )}
                </td>
                <td className={`${td} text-slate-600 dark:text-slate-300`}>{u.email}</td>
                <td className={td}>
                  {owner && u.id !== me.id ? (
                    <>
                      <label htmlFor={`role-${u.id}`} className="sr-only">
                        Role for {u.displayName}
                      </label>
                      <select
                        id={`role-${u.id}`}
                        value={u.role}
                        onChange={(e) => void update(u.id, { role: e.target.value as UserRole })}
                        className={cx(
                          "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900",
                          focusRing,
                        )}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                        <option value="owner">owner</option>
                      </select>
                    </>
                  ) : (
                    <Badge tone={u.role === "member" ? "neutral" : "accent"}>{u.role}</Badge>
                  )}
                </td>
                <td className={td}>
                  {owner ? (
                    <CapEditor
                      user={u}
                      onSave={(cents) => update(u.id, { monthlyCapCents: cents })}
                    />
                  ) : (
                    formatCents(u.monthlyCapCents)
                  )}
                </td>
                <td className={`${td} text-right`}>
                  {owner && u.id !== me.id && (
                    <Button size="sm" variant="danger" onClick={() => void remove(u)}>
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-6">
        <CreateUser
          canCreateAdmin={owner}
          onCreated={(u) => users.setData([...(users.data ?? []), u])}
        />
      </div>
    </Page>
  );
}

function CapEditor({
  user,
  onSave,
}: {
  user: UserDto;
  onSave: (cents: number | null) => Promise<boolean>;
}) {
  const initial = user.monthlyCapCents === null ? "" : (user.monthlyCapCents / 100).toFixed(2);
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const dirty = value !== initial;

  async function save(e: FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(value);
    if (cents === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    await onSave(cents);
  }

  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <label htmlFor={`cap-${user.id}`} className="sr-only">
        Monthly cap in dollars for {user.displayName}
      </label>
      <span className="text-slate-500" aria-hidden="true">
        $
      </span>
      <input
        id={`cap-${user.id}`}
        inputMode="decimal"
        placeholder="No cap"
        value={value}
        aria-invalid={invalid}
        onChange={(e) => setValue(e.target.value)}
        className={cx(
          "w-24 rounded-md border bg-white px-2 py-1 text-sm tabular-nums dark:bg-slate-900",
          invalid ? "border-red-500" : "border-slate-300 dark:border-slate-600",
          focusRing,
        )}
      />
      {dirty && (
        <Button size="sm" type="submit">
          Save
        </Button>
      )}
    </form>
  );
}

function CreateUser({
  canCreateAdmin,
  onCreated,
}: {
  canCreateAdmin: boolean;
  onCreated: (u: UserDto) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.createUser({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        role,
      });
      onCreated(user);
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("member");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Add a user</h2>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Display name"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <TextField
            label="Initial password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <SelectField
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option value="member">member</option>
            {canCreateAdmin && <option value="admin">admin</option>}
          </SelectField>
        </div>
        {!canCreateAdmin && <Muted>Only the owner can create admins.</Muted>}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Adding…" : "Add user"}
        </Button>
      </form>
    </Card>
  );
}
