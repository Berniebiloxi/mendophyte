import { useEffect, useState } from "react";
import { store, useActiveSession } from "../store.js";

const KIND_LABEL: Record<string, string> = {
  answer_question: "question",
  choose_candidate: "choose a candidate (Triage board)",
  state_hypothesis: "state your hypothesis",
  locate_line: "find the line yourself",
  state_fix: "state what the fix is",
  write_test: "write the failing test",
  draft_pr_description: "draft the PR description",
  explain_back: "explain it back",
  confirm_go_ahead: "go-ahead needed",
  confirm_resume: "confirm how to resume",
  other: "your turn",
};

/**
 * The "How This Splits Between Us" queue. Items come from the agent's
 * structured output, never from parsing prose. Answering sends a message
 * addressed to the item; the item stays visibly "answered" until the next
 * state replaces the list.
 */
export function YourTurnPanel() {
  const s = useActiveSession();
  const items = s?.lastState?.your_turn_items ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // A new state list means the previous answers were consumed.
  useEffect(() => {
    setAnswered(new Set());
  }, [s?.id, JSON.stringify(items.map((i) => i.id))]);

  const submit = async (id: string, kind: string, prompt: string) => {
    const text = (answers[id] ?? "").trim();
    if (!text) return;
    setBusy(id);
    try {
      await store.send(`Regarding "${prompt}" (${KIND_LABEL[kind] ?? kind}):\n\n${text}`);
      setAnswered((a) => new Set(a).add(id));
      setAnswers((a) => ({ ...a, [id]: "" }));
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel stack">
      <h2>Your turn</h2>
      {!s && <div className="empty">No session.</div>}
      {s && items.length === 0 && <div className="empty">Nothing is waiting on you. The agent can proceed.</div>}
      {items.map((it) => {
        const done = answered.has(it.id);
        return (
          <div key={it.id} className={`yt-item${done ? " answered" : ""}`}>
            <div className="row">
              <span className="tag bloom">{KIND_LABEL[it.kind] ?? it.kind}</span>
              {it.blocks !== "none" && <span className="tag warn">locks {it.blocks}</span>}
              {done && <span className="tag">sent, awaiting agent</span>}
            </div>
            <div className="prompt">{it.prompt}</div>
            {!done && (
              <>
                <textarea
                  value={answers[it.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [it.id]: e.target.value }))}
                  placeholder={it.kind === "confirm_go_ahead" ? "e.g. yes, go ahead / no, because…" : "Your answer, in your own words"}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(it.id, it.kind, it.prompt);
                  }}
                />
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="faint">⌘/Ctrl+Enter to send</span>
                  <button className="btn primary sm" disabled={busy === it.id || !(answers[it.id] ?? "").trim()} onClick={() => submit(it.id, it.kind, it.prompt)}>
                    Submit
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
