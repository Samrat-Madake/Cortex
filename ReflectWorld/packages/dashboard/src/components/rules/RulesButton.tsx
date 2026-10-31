import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon, type IconName } from "../../theme/icons";
import { tokens } from "../../theme/tokens";
import type { ProceduralRule, Selection } from "../../types";
import { dashboardAuthHeaders, withDashboardQuery, type DashboardSession } from "../../session";

interface RulesButtonProps {
  rules: ProceduralRule[];
  selection: Selection;
  session: DashboardSession;
  onSelectRule: (rule_id: string) => void;
  /** Called after a rule is successfully deleted via API. */
  onRuleDeleted: (rule_id: string) => void;
}

/**
 * Derive the dropdown icon for a rule from its description. Mirrors the
 * Phase 1 heuristic categories in `useProceduralRules` so the icon and the
 * filtering behaviour stay visually consistent.
 */
function iconForRule(description: string): IconName {
  const lower = description.toLowerCase();
  if (/\b(pet|animal|dog|cat)s?\b/.test(lower)) return "pet";
  if (/\b(moved|displacement|change(d|s)?)\b/.test(lower)) return "cube";
  return "cube";
}

/**
 * Purple pill trigger + dropdown panel listing procedural rules.
 *
 * Supports:
 * - Viewing and filtering by procedural rules.
 * - Adding new rules via the Monitor same-origin ReflectWorld proxy.
 * - Deleting existing rules via the Monitor same-origin ReflectWorld proxy.
 */
export function RulesButton({ rules, selection, session, onSelectRule, onRuleDeleted }: RulesButtonProps) {
  const [open, setOpen] = useState(false);
  const [newRuleText, setNewRuleText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = session.userId;

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownId = useId();

  const activeRuleId = selection.kind === "rule" ? selection.rule_id : null;
  const count = rules.length;

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Close dropdown on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        resetAddForm();
      }
    }
    if (open) document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  function resetAddForm() {
    setNewRuleText("");
    setError(null);
  }

  async function handleSave() {
    const text = newRuleText.trim();
    if (!text) return;

    setSaving(true);
    setError(null);

    try {
      const res = await fetch(withDashboardQuery("/api/reflectworld/memories", session), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...dashboardAuthHeaders(session) },
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
          memory_type: "procedural",
          camera_id: "global",
          user_id: userId,
          metadata: {
            camera_id: "global",
            user_id: userId,
            source: "dashboard_rules",
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body.slice(0, 120)}`);
      }

      // Success — the WebSocket memory:memory_added event will add the rule to
      // the list automatically. Reset the form.
      resetAddForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  async function resolveRuleMemoryId(rule: ProceduralRule): Promise<string | null> {
    if (rule.memory_id) return rule.memory_id;

    const resp = await fetch(
      withDashboardQuery("/api/reflectworld/memories?memory_type=procedural&camera_id=global&limit=100", session),
      { headers: dashboardAuthHeaders(session) },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    for (const value of Object.values(data)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const row = item as { id?: unknown; memory?: unknown };
        if (typeof row.id === "string" && typeof row.memory === "string" && row.memory.trim() === rule.description.trim()) {
          return row.id;
        }
      }
    }
    return null;
  }

  async function handleDelete(rule: ProceduralRule) {
    const memoryId = await resolveRuleMemoryId(rule);
    if (!memoryId) {
      setError("Cannot delete: rule has no memory_id");
      return;
    }

    const confirmed = window.confirm(`Delete rule?\n\n"${rule.description}"`);
    if (!confirmed) return;

    setDeletingId(rule.rule_id);
    setError(null);

    try {
      const res = await fetch(withDashboardQuery(`/api/reflectworld/memories/${encodeURIComponent(memoryId)}?memory_type=procedural`, session), {
        method: "DELETE",
        headers: dashboardAuthHeaders(session),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body.slice(0, 120)}`);
      }

      // Remove from local state since there is no memory:memory_deleted
      // WebSocket event that the hook listens to.
      onRuleDeleted(rule.rule_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule");
    } finally {
      setDeletingId(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !saving) {
      handleSave();
    } else if (e.key === "Escape") {
      resetAddForm();
    }
  }

  const triggerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 14px",
    borderRadius: tokens.radius.pill,
    fontSize: 12,
    fontWeight: 500,
    color: tokens.semantic.purple,
    background: tokens.semantic.purpleSoft,
    border: `1px solid ${open ? tokens.semantic.purple : "rgba(139,92,246,0.15)"}`,
    boxShadow: open ? "0 2px 8px rgba(139,92,246,0.15)" : "none",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
    position: "relative",
  };

  const badgeStyle: CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    background: tokens.semantic.purple,
    color: "#fff",
    padding: "0 6px",
    borderRadius: tokens.radius.pill,
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={dropdownId}
        onClick={() => setOpen(v => !v)}
        style={triggerStyle}
      >
        <Icon name="cube" size={14} color={tokens.semantic.purple} /> Rules
        <span style={badgeStyle}>{count}</span>
      </button>

      {open && (
        <div
          id={dropdownId}
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 380,
            background: tokens.bg.surface,
            borderRadius: tokens.radius.lg,
            boxShadow: `${tokens.shadow.elevated}, 0 20px 40px rgba(0,0,0,0.08)`,
            padding: 12,
            zIndex: 300,
          }}
        >
          {/* Header */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.text.primary,
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name="cube" size={16} color={tokens.semantic.purple} /> Procedural Rules
          </div>

          {/* Empty state */}
          {rules.length === 0 && (
            <div style={{ fontSize: 12, color: tokens.text.muted, padding: "8px 4px" }}>
              No procedural rules yet.
            </div>
          )}

          {/* Rule list */}
          {rules.map(rule => {
            const active = rule.rule_id === activeRuleId;
            const fired = rule.triggered_segments.length;
            const isDeleting = deletingId === rule.rule_id;
            return (
              <div
                key={rule.rule_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0,
                  marginBottom: 4,
                  borderRadius: tokens.radius.md,
                  position: "relative",
                }}
                className="rule-item"
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={active}
                  onClick={() => onSelectRule(rule.rule_id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 56,
                    padding: "9px 44px 9px 12px",
                    borderRadius: tokens.radius.md,
                    cursor: "pointer",
                    width: "100%",
                    textAlign: "left",
                    background: active ? tokens.semantic.purpleSoft : "transparent",
                    border: `1px solid ${active ? "rgba(139,92,246,0.2)" : "transparent"}`,
                    fontFamily: "inherit",
                    transition: "all 0.15s",
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: "rgba(139,92,246,0.1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Icon name={iconForRule(rule.description)} size={16} color={tokens.semantic.purple} />
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: tokens.text.secondary,
                      lineHeight: 1.5,
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      minHeight: 32,
                    }}
                  >
                    {rule.description}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: tokens.semantic.purple,
                      background: "rgba(139,92,246,0.1)",
                      padding: "2px 8px",
                      borderRadius: tokens.radius.pill,
                      whiteSpace: "nowrap",
                      alignSelf: "center",
                    }}
                  >
                    {fired} fired
                  </div>
                </button>

                {/* Delete button */}
                <button
                  type="button"
                  aria-label={`Delete rule: ${rule.description}`}
                  disabled={isDeleting}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(rule);
                  }}
                  className="rule-delete"
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: "1px solid rgba(248,113,113,0.25)",
                    background: "rgba(255,255,255,0.9)",
                    color: tokens.semantic.red,
                    cursor: isDeleting ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: isDeleting ? 0.55 : 0,
                    pointerEvents: isDeleting ? "auto" : "none",
                    transition: "opacity 0.15s, background 0.15s, border-color 0.15s",
                    padding: 0,
                  }}
                >
                  <Icon name="trash" size={14} color="currentColor" />
                </button>
              </div>
            );
          })}

          {/* Error message */}
          {error && (
            <div
              style={{
                fontSize: 11,
                color: tokens.semantic.red,
                padding: "6px 4px",
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}

          <style>{`
            .rule-item:hover .rule-delete,
            .rule-delete:focus-visible {
              opacity: 1 !important;
              pointer-events: auto !important;
            }
            .rule-delete:hover {
              background: rgba(254,226,226,0.95) !important;
              border-color: rgba(248,113,113,0.55) !important;
            }
          `}</style>

          {/* Add Rule form */}
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid rgba(15,23,42,0.08)",
            }}
          >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: tokens.text.secondary,
                  marginBottom: 6,
                }}
              >
                Add procedural rule
              </div>
              <input
                ref={inputRef}
                type="text"
                value={newRuleText}
                onChange={e => setNewRuleText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g., Notify when a dog appears in any camera"
                aria-label="New rule description"
                disabled={saving}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontFamily: "inherit",
                  border: `1px solid ${tokens.accent.border}`,
                  borderRadius: tokens.radius.sm,
                  outline: "none",
                  background: tokens.bg.surface,
                  color: tokens.text.primary,
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={resetAddForm}
                  disabled={saving}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    fontFamily: "inherit",
                    padding: "4px 12px",
                    borderRadius: tokens.radius.sm,
                    border: `1px solid rgba(0,0,0,0.1)`,
                    background: "transparent",
                    color: tokens.text.secondary,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !newRuleText.trim()}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    padding: "4px 12px",
                    borderRadius: tokens.radius.sm,
                    border: "none",
                    background: saving || !newRuleText.trim() ? tokens.text.faint : tokens.accent.base,
                    color: "#fff",
                    cursor: saving || !newRuleText.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {saving ? "Adding..." : "Add"}
                </button>
              </div>
            </div>
        </div>
      )}
    </div>
  );
}
