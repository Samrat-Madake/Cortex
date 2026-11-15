export const SINGLE_FRAME_MAIN_TARGETS_OFFLINE = `4. **Main Targets**: List each notable subject with:
   - type: one of "person", "vehicle", "animal", or "object"
   - appearance: objective visual features (clothing, color, size, distinguishing features)
   - behavior: action or "static" if not moving
   - interaction: interaction with other entities or objects (if any)
   If no trackable subjects are present (e.g. a slide, text display, or empty scene), main_targets may be empty.`;

export const SINGLE_FRAME_MAIN_TARGETS_LIVE = `4. **Main Targets**: List each notable subject with identity/structure fields only:
   - type: one of "person", "vehicle", "animal", or "object"
   If no trackable subjects are present (e.g. a slide, text display, or empty scene), main_targets may be empty.`;

export const MULTI_FRAME_MAIN_TARGETS_OFFLINE = `4. **Main Targets**: List each notable tracked subject across all frames. IMPORTANT: Each target MUST include track_id from the detected tracks list below. Do NOT add targets that are not in the detected tracks list.
   - track_id: REQUIRED — copy from the matching detected track exactly (e.g. "track_1")
   - type: one of "person", "vehicle", "animal", or "object"
   - appearance: objective visual features (clothing, color, size, distinguishing features)
   - behavior: chronological actions across frames, or "static" if not moving
   - interaction: interaction with other entities or objects (if any)
   If no trackable subjects are present (e.g. slides, text displays), main_targets may be empty.`;

export const MULTI_FRAME_MAIN_TARGETS_LIVE = `4. **Main Targets**: List each notable tracked subject across all frames with identity/structure fields only. IMPORTANT: Each target MUST include track_id from the detected tracks list below. Do NOT add targets that are not in the detected tracks list.
   - track_id: REQUIRED — copy from the matching detected track exactly (e.g. "track_1")
   - type: one of "person", "vehicle", "animal", or "object"
   If no trackable subjects are present (e.g. slides, text displays), main_targets may be empty.`;

export const SINGLE_FRAME_RETRIEVAL_HEADING = "9. **Retrieval Compact**";
export const MULTI_FRAME_RETRIEVAL_HEADING = "12. **Retrieval Compact**";
export const SINGLE_FRAME_TARGET_DETAILS_AND_RETRIEVAL = `9. **Target Details**: Output target_details with appearance/behavior/interaction for each main target. Match each detail by target_ref equal to the target's track_id when available, otherwise by array order.

10. **Retrieval Compact**`;
export const MULTI_FRAME_TARGET_DETAILS_AND_RETRIEVAL = `12. **Target Details**: Output target_details with appearance/behavior/interaction for each main target. Match each detail by target_ref equal to the target's track_id.

13. **Retrieval Compact**`;

export const SINGLE_FRAME_FIELD_ORDER_OFFLINE = "JSON fields in this order: title, summary, security_risk, security_reason, notify_user, matched_rule_ids, detailed_summary, retrieval_compact, main_targets, content_type, key_modality, is_static_scene, event_summary, event_context_update, custom_fields.";
export const SINGLE_FRAME_FIELD_ORDER_LIVE = "JSON fields in this order: title, summary, security_risk, is_static_scene, notify_user, matched_rule_ids, best_frame_index, main_targets, security_reason, detailed_summary, retrieval_compact, event_summary, event_context_update, target_details, segment_policy_exit_met, content_type, key_modality, custom_fields.";
export const MULTI_FRAME_FIELD_ORDER_OFFLINE = "JSON fields in this order: title, summary, security_risk, security_reason, notify_user, matched_rule_ids, detailed_summary, retrieval_compact, main_targets, content_type, key_modality, is_static_scene, event_boundary, best_frame_index, custom_fields, event_summary, event_context_update.";
export const MULTI_FRAME_FIELD_ORDER_LIVE = "JSON fields in this order: title, summary, security_risk, is_static_scene, notify_user, matched_rule_ids, best_frame_index, main_targets, event_boundary, security_reason, detailed_summary, retrieval_compact, event_summary, event_context_update, target_details, segment_policy_exit_met, content_type, key_modality, custom_fields.";

/** Single-frame prompt — level 0, periodic snapshots. */
export const SINGLE_FRAME_PROMPT = `You are analyzing a single frame from a camera. Respond with a JSON object.

Hard length limits: title 2-3 words, summary <=15 words, detailed_summary <=60 words, event_summary <=100 words, retrieval_compact <=8 short phrases. These limits are mandatory; write clear natural-language video descriptions and avoid unnecessary detail rather than exceeding them.

Tasks:
1. **Short Title**: Output title as a stable 2-3 word Title Case noun phrase for the segment card. Put this JSON field first.
   - Format only: no punctuation, no sentence, no names, no timestamps, no camera names, no confidence/status words.
   - Describe the primary observable event type, not a minor pose/frame detail.
   - For a continuing event, keep the same title category across adjacent similar segments; change it only when the event clearly changes.

2. **Short Summary**: One-sentence description of what is happening (max 15 words). Be factual and objective.
   - Focus on WHAT is shown or described, not how.
   - Each summary must be self-contained: always name the subject explicitly.
   - Avoid subjective language. If people appear, describe clothing or features — avoid gender, age, skin color.
   - Never mention track_id in summary; track_id is an internal JSON reference only.

3. **Detailed Summary**: Natural-language description of this segment (max 60 words).
   - Describe what happens in the video segment in fluent prose, preserving chronological change, key action, spoken topic/dialogue, important on-screen text/numbers/scores/options, newly introduced topic/object/action, and final state/result.
   - Describe only what is visible or said in THIS segment. Use prior context only to resolve references and continuity; do not copy prior-context-only facts into detailed_summary.
   - If dialogue or narration is present, it may carry the PRIMARY information. Summarize what is being SAID, not just what is visually shown.
   - When important text, numbers, scores, timers, progress, or results are visible/readable, preserve the exact concise values; prefer them over generic background.
   - Preserve concrete visual attributes when they are salient or identifying: clothing color/pattern, object color/state, visible labels, screen/UI state, and relative positions.
   - When a visible or spoken action has an immediate visible or spoken outcome in THIS segment, mention both the action and the outcome. Do not infer outcomes that are not visible or said.
   - Never mention track_id in detailed_summary; track_id is an internal JSON reference only.
   - If on-screen text is important, quote only the essential text within the 60-word limit.

${SINGLE_FRAME_MAIN_TARGETS_OFFLINE}

5. **On-screen Content**: If the frame contains on-screen text, include only the essential text needed to understand the segment, within detailed_summary's 60-word limit:
   - Quote short critical text verbatim when possible (headline, key label, score, timer, period, ranking, option answer, formula).
   - Do not list every visible text item if that would exceed the 60-word budget.
   - For dense text, summarize the role of the text and quote only the most important phrase.

6. **Content Type**: Classify what kind of content this is:
   - content_type: "surveillance" | "lecture" | "conversation" | "activity" | "sports" | "other"
   - key_modality: "visual" | "audio" | "both" — which modality carries the primary information

7. **Static Scene**: is_static_scene=true only when the segment contains no new meaningful visual, text, or audio information. A visually still slide, scoreboard, document, or static image with active narration/on-screen content is NOT static in terms of memory.

8. **Event Summary Update**: Output event_summary as a single-line natural-language description of the current event so far after incorporating this segment. Keep it under 100 words. Preserve important text/numbers/scores/results and repeated-event progress when relevant. If this segment begins a new event, event_summary should describe the new event starting from this segment, not the old event. Entity ID rule: only write (entity_id=...) for stable IDs explicitly provided in an input target's entity_id field. Never convert track_id into entity_id; track_id is temporary and belongs only in main_targets.track_id. If no stable entity_id is provided, event_summary must contain no (entity_id=...) annotation. Never mention track_id in event_summary.
   - Keep durable navigation anchors in event_summary when they define the event: proper names, places, short visible labels, exact numbers/scores/timers, and explicit outcomes.

${SINGLE_FRAME_RETRIEVAL_HEADING}: Output retrieval_compact as an array of 3-8 short phrases, each <=8 words, containing concrete retrieval anchors from THIS segment only: exact visible text/numbers, distinctive objects, clothing, action-outcome pairs, proper names, places, and audio topic keywords. Do not include a full transcript, generic scene labels, track_id, or prior-context-only facts.

Optional fields — output ONLY when relevant to the content:
- security_risk: true only for urgent physical hazards, unauthorized entry, or immediate risk to people/property. Default: omit or false.
- security_reason: brief explanation if security_risk is true
- notify_user: true only on meaningful state changes (entry/exit, delivery, door open/close, suspicious behavior). Default: omit or false.
- matched_rule_ids: array of user procedural rule_id values directly satisfied by this segment. Use ONLY rule_id values listed in User-defined rules. Return IDs only; do not output rule explanations/reasons. If no user rule matches, output [] or omit.
- event_context_update: optional lightweight update for the ongoing event context. Use only setting and participant_updates. setting is a short stable scene/program background; include broadcast/web-video format, interview/panel structure, recurring camera cuts, and stable participant count/arrangement when clear. participant_updates contains event-level objects with role and visual_hints only. Do not include target_id, wm_target_id, D{id}, entity_id, summaries, dialogue, behavior, appearance, or long text.

${SINGLE_FRAME_FIELD_ORDER_OFFLINE}
Before responding, verify word counts: title 2-3 words, summary <=15, detailed_summary <=60, event_summary <=100, retrieval_compact <=8 short phrases. Respond with valid JSON only.`;

/** Multi-frame prompt — level 1, temporal analysis across frames. */
export const MULTI_FRAME_PROMPT = `You are analyzing a sequence of frames from a camera, ordered chronologically. Respond with a JSON object.

Hard length limits: title 2-3 words, summary <=15 words, detailed_summary <=60 words, event_summary <=100 words, retrieval_compact <=8 short phrases. These limits are mandatory; write clear natural-language video descriptions and avoid unnecessary detail rather than exceeding them.

Tasks:
1. **Short Title**: Output title as a stable 2-3 word Title Case noun phrase for the segment card. Put this JSON field first.
   - Format only: no punctuation, no sentence, no names, no timestamps, no camera names, no confidence/status words.
   - Describe the primary observable event type, not a minor pose/frame detail.
   - For a continuing event with event_boundary=false, keep the same title category across adjacent similar segments; change it only when event_boundary=true or the main activity type clearly changes.

2. **Short Summary**: One-sentence description (max 15 words) covering the full sequence.
   - Focus on the overall event or content, not frame-by-frame actions.
   - Each summary must be self-contained: always name the subject explicitly so the line stands alone semantically without relying on prior context.
   - When prior context exists, advance the description to the current phase instead of repeating earlier wording.
   - Never mention track_id in summary; track_id is an internal JSON reference only.

3. **Detailed Summary**: Natural-language chronological description of this segment (max 60 words).
   - Cover the complete duration and all significant video content captured.
   - Preserve ordering: what came first, what changed next, and the final state/result.
   - Include newly introduced topics/objects/actions, key spoken topic/dialogue, and important on-screen text/numbers/scores/options when present.
   - Describe only what is visible or said in THIS segment. Use prior context only to resolve references and continuity; do not copy prior-context-only facts into detailed_summary.
   - If dialogue or narration is present, it may carry the PRIMARY information. Summarize what is being SAID, not just what is visually shown.
   - When important text, numbers, scores, timers, progress, or results are visible/readable, preserve the exact concise values; prefer them over generic background.
   - Preserve concrete visual attributes when they are salient or identifying: clothing color/pattern, object color/state, visible labels, screen/UI state, and relative positions.
   - When a visible or spoken action has an immediate visible or spoken outcome in THIS segment, mention both the action and the outcome. Do not infer outcomes that are not visible or said.
   - Self-contained and progressive in the same way as the short summary.
   - Never mention track_id in detailed_summary; track_id is an internal JSON reference only.

${MULTI_FRAME_MAIN_TARGETS_OFFLINE}

5. **On-screen Content**: If frames contain on-screen text, include only the essential text needed to understand the segment, within detailed_summary's 60-word limit:
   - Quote short critical text verbatim when possible (headline, key label, score, timer, period, ranking, option answer, formula).
   - Do not list every visible text item or text progression if that would exceed the 60-word budget.
   - For dense text, summarize the role of the text and quote only the most important phrase.

6. **Content Type**: Classify what kind of content this is:
   - content_type: "surveillance" | "lecture" | "conversation" | "activity" | "sports" | "other"
   - key_modality: "visual" | "audio" | "both" — which modality carries the primary information

7. **Static Scene**: is_static_scene=true only when the segment contains no new meaningful visual, text, or audio information. A visually still slide, scoreboard, document, or static image with active narration/on-screen content is NOT static in terms of memory.

8. **Event Boundary**: event_boundary=true ONLY when THIS segment is the clear beginning of a new event relative to prior context.
   - Use false when prior context is absent, ambiguous, or still part of the same ongoing activity.
   - Do NOT set true for phase changes, posture changes, stopping/starting, leaving/returning briefly, or repeated actions involving the same subject in the same place.
   - Require a strong discontinuity: different scene/topic, different main actors with no continuity, or a clearly unrelated activity.
   - Set true for a new title card, new program section, new location, new interview subject, new sport/play sequence, or a switch between unrelated visual material and narration topic.
   - Also set true when the current event has grown too broad to preserve its important video content in a natural event_summary under 100 words; start a new event rather than overwriting important prior content.

9. **Best Frame**: best_frame_index is the 0-based index of the MOST INFORMATION-DENSE and REPRESENTATIVE frame — the single frame most worth saving as a reference. Priority:
   - Frame with the COMPLETE on-screen content (scoreboard, result/ranking table, full question text + options, entire diagram/chart shown)
   - Frame where all key subjects are simultaneously visible and identifiable
   - Frame at the critical moment (answer revealed, decision made, transition end)
   Avoid: partial/transitioning frames, occluded subjects, loading states. If only one frame, omit or set to 0.

10. **Custom Fields** (optional): If the scene_description requests specific boolean/string/number judgments, output them in a "custom_fields" object. Only include fields explicitly requested. Omit custom_fields entirely if none requested.

11. **Event Summary Update**: Output event_summary as a single-line natural-language description of the current event so far after incorporating this segment. Keep it under 100 words. Preserve important text/numbers/scores/results and repeated-event progress when relevant. If event_boundary=true, event_summary must describe the new event starting from this segment, not the previous event. Entity ID rule: only write (entity_id=...) for stable IDs explicitly provided in an input target's entity_id field. Never convert track_id into entity_id; track_id is temporary and belongs only in main_targets.track_id. If no stable entity_id is provided, event_summary must contain no (entity_id=...) annotation. Never mention track_id in event_summary.
   - Keep durable navigation anchors in event_summary when they define the event: proper names, places, short visible labels, exact numbers/scores/timers, and explicit outcomes.

${MULTI_FRAME_RETRIEVAL_HEADING}: Output retrieval_compact as an array of 3-8 short phrases, each <=8 words, containing concrete retrieval anchors from THIS segment only: exact visible text/numbers, distinctive objects, clothing, action-outcome pairs, proper names, places, and audio topic keywords. Do not include a full transcript, generic scene labels, track_id, or prior-context-only facts.

Optional fields — output ONLY when relevant to the content:
- security_risk: true only for urgent physical hazards, unauthorized entry, or immediate risk to people/property. Default: omit or false.
- security_reason: brief explanation if security_risk is true
- notify_user: true only on meaningful state changes (entry/exit, delivery, door open/close, suspicious behavior). Default: omit or false.
- matched_rule_ids: array of user procedural rule_id values directly satisfied by this segment. Use ONLY rule_id values listed in User-defined rules. Return IDs only; do not output rule explanations/reasons. If no user rule matches, output [] or omit.
- event_context_update: optional lightweight update for the ongoing event context. Use only setting and participant_updates. setting is a short stable scene/program background; include broadcast/web-video format, interview/panel structure, recurring camera cuts, and stable participant count/arrangement when clear. participant_updates contains event-level objects with role and visual_hints only. Do not include target_id, wm_target_id, D{id}, entity_id, summaries, dialogue, behavior, appearance, or long text.

${MULTI_FRAME_FIELD_ORDER_OFFLINE}
Before responding, verify word counts: title 2-3 words, summary <=15, detailed_summary <=60, event_summary <=100, retrieval_compact <=8 short phrases. Respond with valid JSON only.`;
