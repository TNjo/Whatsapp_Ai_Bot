"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  Plug,
  Plus,
  ServerCog,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { ConfirmButton, Field, NativeSelect } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { BotSettingsView, ProviderOption } from "@/server/admin/bot";
import { SaveBar } from "./save-bar";

type ProviderValue = ProviderOption["value"];

type FormState = Pick<
  BotSettingsView,
  | "botName"
  | "welcomeMessage"
  | "businessDescription"
  | "instructions"
  | "rules"
  | "aiEnabled"
  | "humanHandoffEnabled"
  | "handoffMessage"
  | "testModeCreatesOrders"
  | "aiProvider"
  | "aiModel"
  | "aiBaseUrl"
>;

type TestResult = { ok: true; provider: string; model: string; reply: string; latencyMs?: number } | { ok: false; error: string };

function pickForm(view: BotSettingsView): FormState {
  return {
    botName: view.botName,
    welcomeMessage: view.welcomeMessage,
    businessDescription: view.businessDescription,
    instructions: view.instructions,
    rules: view.rules,
    aiEnabled: view.aiEnabled,
    humanHandoffEnabled: view.humanHandoffEnabled,
    handoffMessage: view.handoffMessage,
    testModeCreatesOrders: view.testModeCreatesOrders,
    aiProvider: view.aiProvider,
    aiModel: view.aiModel,
    aiBaseUrl: view.aiBaseUrl,
  };
}

function changedKeys(a: FormState, b: FormState) {
  return (Object.keys(a) as (keyof FormState)[]).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

const newRuleId = () => `custom-${Math.random().toString(36).slice(2, 10)}`;

export function BotSettingsForm({
  initial,
  providers,
  defaultRuleIds,
  canEdit,
}: {
  initial: BotSettingsView;
  providers: ProviderOption[];
  defaultRuleIds: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [baseline, setBaseline] = useState(() => pickForm(initial));
  const [form, setForm] = useState(() => pickForm(initial));
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusRule, setFocusRule] = useState<string | null>(null);

  const changed = useMemo(() => changedKeys(form, baseline), [form, baseline]);
  const dirty = changed.length > 0 || apiKey.trim() !== "";
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const applyView = (next: BotSettingsView) => {
    setView(next);
    setBaseline(pickForm(next));
    setForm(pickForm(next));
    setApiKey("");
  };

  const save = async () => {
    const body: Record<string, unknown> = {};
    for (const key of changed) body[key] = form[key];
    if (body.rules) body.rules = form.rules.filter((rule) => rule.text.trim());
    if (apiKey.trim()) body.aiApiKey = apiKey.trim();
    setSaving(true);
    setSaveError(null);
    try {
      const data = await api<{ settings: BotSettingsView }>("/api/bot/settings", { method: "PUT", body });
      applyView(data.settings);
      toast.success("Bot settings saved");
      router.refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      const data = await api<{ settings: BotSettingsView }>("/api/bot/settings", { method: "PUT", body: { removeAiKey: true } });
      // Keep any other unsaved edits in the form.
      setView(data.settings);
      toast.success("API key removed");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const updateRule = (id: string, patch: Partial<FormState["rules"][number]>) =>
    set(
      "rules",
      form.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );

  const addRule = () => {
    const id = newRuleId();
    set("rules", [...form.rules, { id, text: "", enabled: true }]);
    setFocusRule(id);
  };

  return (
    <div>
      {!canEdit ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" /> Only the business owner can change bot settings. You can view them here.
        </div>
      ) : null}

      <fieldset disabled={!canEdit} className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <div className="grid min-w-0 gap-6">
          <SectionCard title="Identity" description="How the assistant introduces itself and describes your business.">
            <div className="grid gap-4">
              <Field label="Bot name" htmlFor="bot-name" hint="Customers see this when the assistant introduces itself.">
                <Input id="bot-name" value={form.botName} maxLength={80} onChange={(e) => set("botName", e.target.value)} />
              </Field>
              <Field
                label="Welcome message"
                htmlFor="bot-welcome"
                hint="Sent when a customer messages you for the first time (for example “hi”)."
              >
                <Textarea
                  id="bot-welcome"
                  rows={3}
                  maxLength={1000}
                  value={form.welcomeMessage}
                  onChange={(e) => set("welcomeMessage", e.target.value)}
                />
              </Field>
              <Field
                label="Business description"
                htmlFor="bot-description"
                hint="A few sentences about what you sell. This is the same description as in your business profile."
              >
                <Textarea
                  id="bot-description"
                  rows={3}
                  maxLength={2000}
                  value={form.businessDescription}
                  placeholder="Home-made cakes and desserts in Colombo, made to order."
                  onChange={(e) => set("businessDescription", e.target.value)}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard
            title="AI instructions"
            description="Tell the assistant how to behave: tone, what to focus on and what to avoid. Plain language works best."
          >
            <Textarea
              aria-label="AI instructions"
              rows={12}
              maxLength={8000}
              className="min-h-64 leading-relaxed"
              value={form.instructions}
              onChange={(e) => set("instructions", e.target.value)}
            />
            <p className="mt-2 text-right text-xs text-muted-foreground tabular-nums">{form.instructions.length.toLocaleString()} / 8,000</p>
          </SectionCard>

          <SectionCard
            title="Rules"
            description="Hard rules the assistant must always follow. Switch a rule off to stop enforcing it."
            actions={
              <Button type="button" variant="outline" size="sm" onClick={addRule}>
                <Plus className="size-3.5" /> Add rule
              </Button>
            }
            bodyClassName="p-0"
          >
            <ul className="divide-y">
              {form.rules.map((rule) => {
                const builtIn = defaultRuleIds.includes(rule.id);
                return (
                  <li key={rule.id} className="flex items-center gap-3 px-5 py-3">
                    <Switch
                      checked={rule.enabled}
                      disabled={!canEdit}
                      onCheckedChange={(checked) => updateRule(rule.id, { enabled: checked })}
                      aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
                    />
                    <Input
                      value={rule.text}
                      maxLength={300}
                      aria-label="Rule text"
                      autoFocus={focusRule === rule.id}
                      placeholder="e.g. Always mention that cakes need 2 days' notice."
                      onChange={(e) => updateRule(rule.id, { text: e.target.value })}
                      className={cn("flex-1", !rule.enabled && "text-muted-foreground line-through decoration-muted-foreground/50")}
                    />
                    {builtIn ? (
                      <Badge variant="secondary" className="hidden sm:inline-flex">
                        Default
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete rule"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => set("rules", form.rules.filter((r) => r.id !== rule.id))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
              {!form.rules.length ? <li className="px-5 py-8 text-center text-sm text-muted-foreground">No rules yet.</li> : null}
            </ul>
          </SectionCard>
        </div>

        <div className="grid min-w-0 gap-6">
          <SectionCard title="Behaviour" description="Control when the assistant replies and when it hands over to your team.">
            <div className="grid gap-5">
              <SwitchRow
                id="ai-enabled"
                label="AI replies"
                description="When off, the assistant stays silent and incoming messages are only stored in Conversations."
                checked={form.aiEnabled}
                disabled={!canEdit}
                onChange={(v) => set("aiEnabled", v)}
              />
              <SwitchRow
                id="handoff-enabled"
                label="Human handoff"
                description="Let the assistant pass a conversation to your team when it can't help or the customer asks for a person."
                checked={form.humanHandoffEnabled}
                disabled={!canEdit}
                onChange={(v) => set("humanHandoffEnabled", v)}
              />
              {form.humanHandoffEnabled ? (
                <Field label="Handoff message" htmlFor="handoff-message" hint="Sent to the customer when the conversation is handed over.">
                  <Textarea
                    id="handoff-message"
                    rows={3}
                    maxLength={1000}
                    value={form.handoffMessage}
                    onChange={(e) => set("handoffMessage", e.target.value)}
                  />
                </Field>
              ) : null}
              <SwitchRow
                id="test-orders"
                label="Test mode can create real orders"
                description={
                  form.testModeCreatesOrders
                    ? "Orders placed from the Test bot are created as normal orders and count in your reports."
                    : "Off: orders placed from the Test bot are marked TEST and never counted in sales or stock."
                }
                checked={form.testModeCreatesOrders}
                disabled={!canEdit}
                onChange={(v) => set("testModeCreatesOrders", v)}
              />
            </div>
          </SectionCard>

          <AIProviderCard
            view={view}
            form={form}
            providers={providers}
            apiKey={apiKey}
            canEdit={canEdit}
            onApiKey={setApiKey}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            onRemoveKey={removeKey}
          />
        </div>
      </fieldset>

      {canEdit ? (
        <SaveBar
          error={saveError}
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setForm(baseline);
            setApiKey("");
            setSaveError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

function AIProviderCard({
  view,
  form,
  providers,
  apiKey,
  canEdit,
  onApiKey,
  onChange,
  onRemoveKey,
}: {
  view: BotSettingsView;
  form: FormState;
  providers: ProviderOption[];
  apiKey: string;
  canEdit: boolean;
  onApiKey: (value: string) => void;
  onChange: (patch: Partial<FormState>) => void;
  onRemoveKey: () => Promise<void>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const provider = providers.find((p) => p.value === form.aiProvider) ?? null;
  const suggestions = [...new Set([provider?.defaultModel, ...models].filter((m): m is string => Boolean(m)))];
  const providerLabel = (value: string) => providers.find((p) => p.value === value)?.label ?? value;

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const data = await api<{ ok: true; provider: string; model: string; reply: string; latencyMs?: number; models?: string[] }>(
        "/api/bot/settings/test",
        { body: { aiProvider: form.aiProvider, aiModel: form.aiModel, aiBaseUrl: form.aiBaseUrl, aiApiKey: apiKey.trim() } },
      );
      setResult(data);
      if (data.models?.length) setModels(data.models);
    } catch (err) {
      setResult({ ok: false, error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SectionCard title="AI provider" description="The AI model that writes the assistant's replies. Your API key is encrypted and never shown again.">
      <div className="grid gap-4">
        <AIStatus view={view} providerLabel={providerLabel} />

        <Field label="Provider" htmlFor="ai-provider">
          <NativeSelect
            id="ai-provider"
            value={form.aiProvider ?? ""}
            onChange={(e) => {
              const value = (e.target.value || null) as ProviderValue | null;
              onChange({ aiProvider: value, aiModel: "", aiBaseUrl: "" });
              setModels([]);
              setResult(null);
            }}
          >
            <option value="">Server default</option>
            {providers.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </Field>

        {provider ? (
          <>
            <Field
              label="Model"
              htmlFor="ai-model"
              hint={provider.defaultModel ? `Leave empty to use ${provider.defaultModel}.` : "The model id from your provider."}
            >
              <Input
                id="ai-model"
                list="ai-model-suggestions"
                value={form.aiModel}
                maxLength={120}
                placeholder={provider.defaultModel || "model-name"}
                onChange={(e) => onChange({ aiModel: e.target.value })}
              />
              <datalist id="ai-model-suggestions">
                {suggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field
              label={provider.value === "custom" ? "API URL" : "API URL (optional)"}
              htmlFor="ai-base-url"
              hint={
                provider.value === "custom"
                  ? "Base URL of an OpenAI-compatible API, e.g. https://api.example.com/v1"
                  : `Leave empty to use ${provider.defaultBaseUrl || "the provider's default"}.`
              }
            >
              <Input
                id="ai-base-url"
                type="url"
                value={form.aiBaseUrl}
                maxLength={300}
                placeholder={provider.defaultBaseUrl || "https://api.example.com/v1"}
                onChange={(e) => onChange({ aiBaseUrl: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <p className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <ServerCog className="mt-0.5 size-4 shrink-0" />
            Uses the AI provider and key configured on the server by your administrator.
          </p>
        )}

        <Field
          label="API key"
          htmlFor="ai-key"
          hint={
            view.aiKeySource === "business"
              ? "Leave empty to keep the saved key. Paste a new key to replace it."
              : provider
                ? "Paste the API key from your provider's dashboard."
                : "Optional. A key saved here is used instead of the server's key."
          }
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="pl-8"
                value={apiKey}
                maxLength={500}
                placeholder={view.aiKeySource === "business" ? `Saved key ending in ${view.aiKeyHint}` : "Paste API key"}
                onChange={(e) => onApiKey(e.target.value)}
              />
            </div>
            {view.aiKeySource === "business" && canEdit ? (
              <ConfirmButton
                type="button"
                variant="outline"
                title="Remove the saved API key?"
                description="The assistant will fall back to the server's AI key if one is configured. Otherwise it stops replying until you add a new key."
                confirmLabel="Remove key"
                destructive
                onConfirm={onRemoveKey}
              >
                Remove key
              </ConfirmButton>
            ) : null}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={test} disabled={testing || !canEdit}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            Test connection
          </Button>
          <span className="text-xs text-muted-foreground">Uses the values above, even before you save.</span>
        </div>

        {result ? (
          result.ok ? (
            <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">
                  Connected to {providerLabel(result.provider)}
                  {result.model ? ` · ${result.model}` : ""}
                  {result.latencyMs ? ` in ${(result.latencyMs / 1000).toFixed(1)}s` : ""}
                </p>
                <p className="mt-0.5 truncate opacity-80">Reply: “{result.reply}”</p>
                {models.length ? <p className="mt-0.5 opacity-80">{models.length} models available — pick one from the Model list.</p> : null}
              </div>
            </div>
          ) : (
            <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">Connection failed</p>
                <p className="mt-0.5">{result.error}</p>
              </div>
            </div>
          )
        ) : null}
      </div>
    </SectionCard>
  );
}

function AIStatus({ view, providerLabel }: { view: BotSettingsView; providerLabel: (value: string) => string }) {
  if (!view.effectiveAI) {
    return (
      <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium">No AI configured.</span> Choose a provider and add an API key — until then the assistant can&apos;t reply to
          customers.
        </p>
      </div>
    );
  }
  const source = view.aiKeySource === "business" ? `your key ending in ${view.aiKeyHint}` : "the server's key";
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm">
      <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <p className="min-w-0 text-muted-foreground">
        Currently using <span className="font-medium text-foreground">{providerLabel(view.effectiveAI.provider)}</span>
        {view.effectiveAI.model ? (
          <>
            {" "}
            · <span className="font-mono text-xs text-foreground">{view.effectiveAI.model}</span>
          </>
        ) : null}{" "}
        with {source}.
      </p>
    </div>
  );
}
