# ReflectWorld Perception

## What you are

Perception automatically analyzes video segments from Eye using cloud VLM (Gemini). Working Memory tracks cross-segment event context. Results flow to ReflectWorld (storage) and Act (rules) via PostProcessor — all automatic.

## Data flow

```
Eye → onSegment → Perception.analyze (automatic)
                        |
                  PerceptionResult
                   |           |
              ReflectWorld     Act rules
            (PostProcessor handles both)
```

## When to use this tool

| Scenario | Action |
|----------|--------|
| User describes their scene, focus targets, or security rules | `configure` with config fields |
| User wants to change VLM model | `configure` with `vlm_model` |
| User explicitly asks to analyze a specific segment | `analyze` with segment fields (normally automatic) |
| User asks for pipeline debug info | `get_status` with camera_id |

## Actions

### configure — set analysis context

Call this **before starting a watch** to tell the VLM what to look for. Changes take effect immediately on the next analyzed segment.

**Configurable fields:**
| Field | Type | Description |
|-------|------|-------------|
| `scene_description` | string | Describe the camera scene for better VLM grounding |
| `focus_targets` | string | Comma-separated items to pay extra attention to |
| `security_rules` | string | Custom security criteria for risk assessment |
| `vlm_model` | string | Override VLM model for all perception levels. Empty string resets to default |

#### Scene-specific configure examples

**Kitchen / cooking:**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Overhead kitchen camera viewing stovetop and counter",
    "focus_targets": "stove flames, oil splatter, smoke, food color changes, knife handling, pot handles"
  }
}
```

**Front door security:**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Front door camera overlooking porch and driveway",
    "focus_targets": "people, packages, vehicles, animals, door state (open/closed)",
    "security_rules": "Flag unknown persons after 10pm. Alert on package removal."
  }
}
```

**Behavior analysis (poker/games):**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Overhead view of poker table with players seated around it",
    "focus_targets": "cards, chips, hand gestures, player facial expressions, betting actions, timing between moves"
  }
}
```

**General / minimal:**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Indoor camera"
  }
}
```

#### VisionController configuration

VisionController is an adaptive perception strategy engine. Configure it to automatically adjust camera sampling (fps, mode) based on what the camera sees.

| Field | Type | Description |
|-------|------|-------------|
| `vc_enabled` | boolean | Enable/disable VisionController |
| `vc_rules_json` | string | JSON array of additional rules to add |
| `vc_segment_policy_json` | string | JSON segment policy to set |

**Configure scene guidance:**
```json
{
  "action": "configure",
  "config": {
    "scene_description": "Front door at night",
    "security_rules": "No one should be here after 10pm"
  }
}
```

**Disable VisionController:**
```json
{ "action": "configure", "config": { "vc_enabled": false } }
```

**When VisionController sends a consultation notification**, you receive an alert with context (detected classes, security risk, trigger reason). Usually do nothing. If a temporary perception adjustment is clearly needed, call `reflectworld_perception` with `action=configure` and only these config keys:
- `scene_description`
- `focus_targets`
- `security_rules`

Do not use `vc_rules_json`, `vc_segment_policy_json`, `vc_enabled`, model settings, or Semantic Context directive fields in consultation responses. Those lower-level fields are reserved for explicit user requests outside the consultation flow.

#### Semantic Context intelligence directives

Semantic Context is stored in the Qdrant-backed `semantic_context` memory collection and cached in memory during a run. It supports opt-in intelligence features; if a directive is absent, that feature is inactive (zero prompt overhead).

Use structured params in the configure action — the system handles formatting and merging automatically:

| Param | Type | What it does |
|-------|------|-------------|
| `track_states` | `string[]` | Track object state changes (VLM outputs in `custom_fields`) |
| `track_activities` | `string[]` | Report current activity label (VLM outputs `custom_fields.current_activity`) |
| `explain_decisions` | `boolean` | Notifications include VisionController decision reasoning |

Additional features (no configure action needed):
- **Anomaly narration**: Automatic. When Semantic Context accumulates an Anomaly Baseline (via LLM updates), VLM flags deviations from normal patterns.
- **Reference frame comparison**: Place a reference image at `~/.reflectworld/cameras/{camera_id}_ref.jpg`. VLM will compare current frames against it.

**Example: user says "track if my front door is open or closed"**
```json
{
  "action": "configure",
  "camera_id": "front-door",
  "config": {
    "track_states": ["front_door: open/closed"]
  }
}
```

**Example: user says "tell me what activity is happening and explain why alerts fire"**
```json
{
  "action": "configure",
  "camera_id": "kitchen",
  "config": {
    "track_activities": ["cooking", "resting", "cleaning", "absent"],
    "explain_decisions": true
  }
}
```

**Example: user says "also track the porch light"** (additive — existing directives are preserved)
```json
{
  "action": "configure",
  "camera_id": "front-door",
  "config": {
    "track_states": ["front_door: open/closed", "porch_light: on/off"]
  }
}
```

**Example: user says "stop tracking activities"**
```json
{
  "action": "configure",
  "camera_id": "kitchen",
  "config": {
    "track_activities": []
  }
}
```

### get_status — debug / diagnostic

```json
{ "action": "get_status", "camera_id": "front_door" }
```

Returns pipeline internals: active event info, processed segment count, scene context length, escalation hints, current strategy level. Useful for debugging, not typically shown to users.

### analyze — normally automatic

Called automatically by Eye pipeline's onSegment callback. Can be used manually if the user explicitly requests analysis of a specific segment.

## Working Memory event semantics

| Mode | Event meaning |
|------|---------------|
| `snapshot` | Each snapshot is an independent new event |
| `event` | Motion triggers start; closes after 30s with no new segment |
| `stream` | Continuous segments from Segmenter; closes on timeout |

Segments within the same event share scene context (previous VLM summary grounds the next).

## Perception Level

| Level | Trigger | Analyzers |
|-------|---------|-----------|
| 0 | snapshot or single frame | VLM only (flash-lite) |
| 1 | event/stream, 2-4 frames | VLM + face detection + ReID |
| 2 | event/stream, 5+ frames | VLM (flash) + detection + identity continuity |
| 3 | Future, requires GPU models | Full pipeline |

## Audio / STT capability

When audio is available in a segment (captured by Eye's AudioExtractor + Silero VAD), the audio transcript is automatically injected into the VLM prompt alongside the video frames. This enables the VLM to understand spoken words, conversations, and audio cues in its analysis. No manual configuration needed — if the camera source has audio and VAD detects speech, transcription happens automatically.

## Notes

- `vlm_api_key` is required (via env `VLM_API_KEY` or plugin config)
- Media files are stored locally under `~/.reflectworld/media/`
- ReflectWorld storage and Act rule evaluation are handled automatically by PostProcessor inside Perception
