# VisionController — Adaptive Perception Strategy

VisionController dynamically adjusts camera sampling and analysis parameters based on perception results. Two policies:

- **Frame Policy**: Deterministic rules evaluated in milliseconds after frame detection. Adjusts camera sampling.
- **Segment Policy**: Fire-and-forget notification via Notifier when segment_policy conditions match. Agent decides what to do.

## Configuration

```typescript
perception.configure({
  vision_controller: {
    enabled: true,
    baseline: { fps: 1 },
    auto_rules: [
      {
        name: "person_present",
        trigger: { type: "class_detected", class: "person" },
        action: { fps: 2 },
        cooldown_ms: 5000,
        hold_ms: 30000,
      },
    ],
    segment_policy: {
      consultation_triggers: [{ type: "security_risk" }],
      consultation_cooldown_seconds: 60,
    },
  },
});
```

## Action Parameters

| Parameter | Type | Effect |
|-----------|------|--------|
| `fps` | number | Cam sampling rate (frames per second) |
| `mode` | "event" \| "stream" | Cam capture mode |
| `max_level` | 0 \| 1 \| 2 | Perception level cap |
| `vlm_model` | string | VLM model override (e.g. "gemini-2.5-flash-lite") |

## Rule Matching

- Rules ordered by priority (index 0 = highest)
- **All rules scanned**; action fields merge with **first-write-wins** semantics
- Each rule must explicitly set all intended fields
- Unset fields = "don't care, keep current"
- **No rules matched → baseline applied entirely**

## Trigger Conditions

| Type | Params | Description |
|------|--------|-------------|
| `class_detected` | class: string | Class present in current segment |
| `class_absent` | class: string | Class NOT present |
| `class_disappeared` | class: string | Was present last segment, gone now (edge trigger) |
| `class_count_gte` | class, count | Count of class ≥ threshold |
| `face_detected` | — | Any face detected |
| `motion_sustained_ms` | duration | Continuous motion for N ms |
| `no_motion_ms` | duration | No motion for N ms |
| `voice_detected` | — | Speech detected (VAD/STT) |
| `unknown_entity` | — | New entity (first time seen) |
| `known_entity` | entity_id | Specific known entity present |
| `security_risk` | — | VLM flagged security risk |
| `static_scene_count` | count | N consecutive static scenes |
| `custom_field` | key, value | VLM custom_fields match |
| `all_of` | conditions[] | AND composite |
| `any_of` | conditions[] | OR composite |

## Custom Fields

Instruct VLM to output extra fields for semantic consultation triggers:

```
"If the poker game has ended (no cards on table, no players), output custom_fields.scene_ended = true"
```

Then configure a segment_policy:
```typescript
segment_policy: {
  consultation_triggers: [{ type: "custom_field", key: "scene_ended", value: true }],
  consultation_cooldown_seconds: 300,
}
```

## Common Patterns

### Basic Frame Policy
```typescript
{
  enabled: true,
  baseline: { fps: 1 },
  auto_rules: [
    { name: "person_present", trigger: { type: "class_detected", class: "person" },
      action: { fps: 2 }, cooldown_ms: 5000, hold_ms: 30000 },
    { name: "moving_object_observe",
      trigger: { type: "all_of", conditions: [
        { type: "any_of", conditions: [
          { type: "class_detected", class: "vehicle" },
          { type: "class_detected", class: "car" },
          { type: "class_detected", class: "truck" },
          { type: "class_detected", class: "bus" },
          { type: "class_detected", class: "animal" },
          { type: "class_detected", class: "dog" },
          { type: "class_detected", class: "cat" },
          { type: "class_detected", class: "bird" },
        ] },
        { type: "motion_sustained_ms", duration: 1000 },
      ] },
      action: { fps: 1 }, cooldown_ms: 5000, hold_ms: 30000 },
  ],
  segment_policy: {
    consultation_triggers: [{ type: "security_risk" }],
    consultation_cooldown_seconds: 60,
  },
}
```

### Scene Exit Detection (via custom_fields)
```typescript
{
  enabled: true,
  baseline: { fps: 1 },
  auto_rules: [],
  segment_policy: {
    consultation_triggers: [{ type: "custom_field", key: "scene_ended", value: true }],
    consultation_cooldown_seconds: 300,
  },
}
```

## Error Handling

- **Cooldown**: Each rule has optional `cooldown_ms`. Rule won't re-fire within the cooldown window.
- **Agent consultation cooldown**: `segment_policy.consultation_cooldown_seconds` prevents spamming the Agent.
- **Per-camera isolation**: All state (signals, cooldowns, consultation timestamps) is per-camera. Multi-camera setups are fully independent.
- **Disabled mode**: When `enabled: false`, VisionController returns baseline and does nothing.
