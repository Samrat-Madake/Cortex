# ReflectWorld — Visual Perception + Memory for AI Agents

You have access to ReflectWorld, a visual perception and persistent memory system. It gives you eyes and memory for cameras.

## Available Tools

| Tool | Purpose |
|------|---------|
| `reflectworld_cam` | Camera control: add sources, snapshot, watch, stop, adjust sampling, switch mode, live view, recordings |
| `reflectworld_perception` | VLM analysis config: set scene description, focus targets, security rules, model override |
| `reflectworld_memory` | Memory search & storage: episodic events, semantic patterns, procedural rules |
| `reflectworld_act` | Automation: notifications, identify requests, rule management |

## Scene Adaptation Workflow

When a user describes what they want to monitor, follow this flow:

```
User describes intent
  → 1. Configure perception (scene_description + focus_targets)
  → 2. Add camera source if not already connected
  → 3. Select watch params (mode, fps, resolution)
  → 4. Store procedural rules in memory for persistent behavior
  → 5. Start watch
```

### Step-by-step

1. **Configure perception first** — Call `reflectworld_perception` with `action=configure` to set `scene_description` and `focus_targets` so the VLM knows what matters. This takes effect immediately on the next analyzed segment.

2. **Add source if needed** — Call `reflectworld_cam` with `action=add_source` if the camera isn't registered yet.

3. **Choose watch parameters** based on the scene:
   - Slow-changing scenes (cooking, front door): `fps=1`, `960x540`
   - Security/motion: `mode=event` (motion-triggered), `fps=1`
   - Behavior analysis (poker, games): `mode=stream`, `fps=0.5`
   - Fast action (sports, pets playing): `fps=2-5`

4. **Store procedural rules** — Call `reflectworld_memory` with `action=add_note`, `memory_type=procedural` for any persistent preferences. Procedural rules are automatically injected into the VLM prompt on every analysis cycle.

5. **Start watch** — Call `reflectworld_cam` with `action=watch`.

## Concrete Examples

### Cooking monitoring
```
perception configure: scene_description="Kitchen overhead camera", focus_targets="stove, oil, fire, smoke, food color"
memory add_note: "Alert me if oil starts smoking or food burns", camera_id="global", memory_type="procedural"
eye watch: name="kitchen", mode="stream", fps=1
```

### Front door security
```
perception configure: scene_description="Front door camera overlooking porch and driveway", focus_targets="people, packages, vehicles, animals"
memory add_note: "Notify me when packages are delivered or picked up", camera_id="cam-front-door", memory_type="procedural"
eye watch: name="front-door", mode="event"
```

### Behavior analysis (poker/games)
```
perception configure: scene_description="Overhead view of poker table with 4 players", focus_targets="cards, chips, hand gestures, player faces, betting actions"
memory add_note: "Track each player's betting patterns and note any unusual timing", camera_id="cam-poker", memory_type="procedural"
eye watch: name="poker-table", mode="stream", fps=0.5
```

## Three-Layer Memory Model

| Layer | Type | Use for | Injected into VLM? |
|-------|------|---------|---------------------|
| Episodic | Raw events | "What happened at 3pm?" — auto-stored by pipeline | No |
| Semantic | Behavioral patterns | "Does this person visit often?" — auto-extracted | No |
| Procedural | User rules & preferences | "Alert me when..." — stored via `add_note` | **Yes** — always injected into VLM prompt |

Use **procedural** memory for any persistent behavior the agent should follow. Use **episodic** search to answer "what happened" questions. Use **semantic** to find patterns across time.

## When to use which tool

| User intent | Tool | Action |
|-------------|------|--------|
| Describe their scene / what to focus on | `reflectworld_perception` | `configure` |
| Add a camera | `reflectworld_cam` | `add_source` |
| Quick look at current state | `reflectworld_cam` | `snapshot` |
| Start continuous monitoring | `reflectworld_cam` | `watch` |
| Change monitoring style mid-session | `reflectworld_cam` | `switch_mode` |
| Adjust fps/resolution mid-session | `reflectworld_cam` | `set_sampling` |
| Ask about past events | `reflectworld_memory` | `search` |
| Set persistent alert/preference | `reflectworld_memory` | `add_note` (procedural) |
| Create automated response rules | `reflectworld_act` | `add_rule` |

## Automatic pipeline

After `watch` starts, the pipeline runs automatically in background:
```
Frame capture → Segmenter → Perception (VLM + procedural rules) → ReflectWorld storage → Act rule matching
```

No manual tool calls needed for the pipeline — just configure, start the watch, and let it run.

## VisionController — Responding to system events

VisionController monitors cameras and sends you **system events** when it detects situations that need your judgment (security risks, unknown entities, scene changes). These appear as system events in your context.

**When you see `[VisionController Consultation]` in a system event, inspect the context and only call `reflectworld_perception` when a temporary perception adjustment is clearly needed.**

### How to respond

1. **Read the consultation**: it tells you the camera, what was detected, and why it triggered
2. **Decide what to do**: usually dismiss; only adjust temporary scene guidance when the current visual context clearly needs it
3. **Call the tool only when needed**: `reflectworld_perception` → `action=configure` with `scene_description`, `focus_targets`, or `security_rules`

### Response examples

**Security risk detected → increase monitoring:**
```json
{
  "action": "configure",
  "config": {
    "security_rules": "Temporarily pay close attention to the unknown person near the entrance and describe whether they linger, approach the door, or leave."
  }
}
```

**Scene changed → update scene guidance:**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Front door after-hours security camera",
    "security_rules": "Describe any person or vehicle that lingers near the entrance after hours."
  }
}
```

**False alarm → dismiss (no action needed):**
Just acknowledge internally. No tool call required.

### Available VisionController config fields

For consultation responses, use only:

| Field | Description |
|-------|-------------|
| `scene_description` | Temporary scene guidance |
| `focus_targets` | Specific targets/regions/text to attend to |
| `security_rules` | Temporary security/safety criteria |

Do not change low-level VisionController rules or Semantic Context directives during a consultation.

For explicit user requests outside consultation, these lower-level fields are also available:

| Field | Description |
|-------|-------------|
| `vc_enabled` | `true` / `false` |
| `vc_rules_json` | JSON array of rules to add |
| `vc_segment_policy_json` | JSON segment policy |
| `track_states` | `string[]` — object states to track, e.g. `["door: open/closed"]` |
| `track_activities` | `string[]` — activity labels, e.g. `["cooking", "resting"]` |
| `explain_decisions` | `boolean` — attach VC reasoning to notifications |

### Semantic Context intelligence directives

These structured params enable per-camera smart features. The system merges them into Semantic Context automatically — no manual markdown formatting needed.

- **Track States** — "track if my door is open/closed" → `track_states: ["door: open/closed"]`
- **Track Activities** — "tell me what's happening" → `track_activities: ["cooking", "resting", "working", "absent"]`
- **Explain Decisions** — "explain why you triggered alerts" → `explain_decisions: true`
- **Reference frame** — user takes a snapshot as "normal state" → save to `~/.reflectworld/cameras/{id}_ref.jpg`, system auto-compares
- **Anomaly detection** — automatic once Semantic Context accumulates daily routine patterns

Opt-in: no param = no overhead. Pass empty array to disable (e.g. `track_states: []`).
