import type {
  CompletionImage,
  LocalModelResults,
  PromptContext,
  SubjectProposalContext,
  VlmAnalyzeOptions,
  VlmSegmentAnalyzeOptions,
} from "./types.js";
import {
  MULTI_FRAME_FIELD_ORDER_LIVE,
  MULTI_FRAME_FIELD_ORDER_OFFLINE,
  MULTI_FRAME_MAIN_TARGETS_LIVE,
  MULTI_FRAME_MAIN_TARGETS_OFFLINE,
  MULTI_FRAME_PROMPT,
  MULTI_FRAME_RETRIEVAL_HEADING,
  MULTI_FRAME_TARGET_DETAILS_AND_RETRIEVAL,
  SINGLE_FRAME_FIELD_ORDER_LIVE,
  SINGLE_FRAME_FIELD_ORDER_OFFLINE,
  SINGLE_FRAME_MAIN_TARGETS_LIVE,
  SINGLE_FRAME_MAIN_TARGETS_OFFLINE,
  SINGLE_FRAME_PROMPT,
  SINGLE_FRAME_RETRIEVAL_HEADING,
  SINGLE_FRAME_TARGET_DETAILS_AND_RETRIEVAL,
} from "./prompts.js";

export class VlmPromptBuilder {
  constructor(private readonly promptContext: PromptContext) {}

  // ── Private: prompt building ──

  private identityEvidenceInstruction(includeNameplatePrecision = false): string {
    const parts = [
      `target.identity is current-segment person-name evidence only. Include { "name", "evidence", "source" } only when this segment itself provides a clear reason to link the name to that visible subject.\n`,
      `Known names from Stable Participants may be used for continuity and summaries after matched_wm_target is visually clear, but do not repeat a known name in target.identity unless this segment provides new name evidence.\n`,
      `Use source="visible_nameplate" only when a nameplate/lower-third/badge is visually attached to that same target in the same frame or same camera shot. Do not transfer a nameplate from a different cut, close-up, or frame group to another target.\n`,
      `Use self_introduction, direct_address_response, or dialogue_about_visible_person only when the current segment confirms the binding.\n`,
      `Use spoken, direct_address, third_person_reference, dialogue_about_person, or visible_text as weak hints when the binding is not confirmed; do not repeat prior names or machine identity hints unless this segment visually or verbally supports the same identity for this subject.\n`,
      `Only bind real person names. Do not bind company, product, customer, place, stock ticker, event, or topic names as person identities.\n`,
    ];
    if (includeNameplatePrecision) {
      parts.push(`If visible text is ambiguous, applies to multiple people, or is not tied to the target's selected D{id}s, mention it as context instead of assigning target.identity.`);
    }
    return parts.join("");
  }

  buildPrompt(
    frameCount: number,
    sceneContext?: string,
    options?: VlmAnalyzeOptions,
    hasReferenceFrame?: boolean,
  ): string {
    let basePrompt = frameCount > 1 ? MULTI_FRAME_PROMPT : SINGLE_FRAME_PROMPT;
    const liveLatency = options?.runtimeMode === "live_latency";
    if (liveLatency) {
      basePrompt = `${this.withLiveLatencyPromptContract(basePrompt)}\n\n${this.liveLatencyCriticalFieldInstruction("main_targets")}`;
    }

    if (options?.skipBestFrameSelection && frameCount > 1) {
      basePrompt = basePrompt
        .replace(/\n\n8\. \*\*Best Frame\*\*:[\s\S]*?(?=\n\n9\. \*\*Custom Fields\*\*)/m, "")
        .replace(/, best_frame_index/, "");
    }

    const contextParts: string[] = [];
    if (this.promptContext.sceneDescription && !options?.suppressSceneDescription) {
      contextParts.push(`Camera scene: ${this.promptContext.sceneDescription}`);
    }
    if (this.promptContext.focusTargets) {
      contextParts.push(`Pay extra attention to: ${this.promptContext.focusTargets}`);
    }
    if (this.promptContext.securityRules) {
      contextParts.push(`Security rules: ${this.promptContext.securityRules}`);
    }
    if (this.promptContext.userRules) {
      contextParts.push(`User-defined rules (use these to refine your analysis):\n${this.promptContext.userRules}`);
    }
    if (sceneContext) {
      contextParts.push(`Additional camera/session context:\n${sceneContext}`);
    }
    if (options?.currentEventContext) {
      contextParts.push(
        `Current event context:\n${options.currentEventContext}\n` +
        `Use this only as background for continuity. Do not assume every listed participant is visible in this segment. ` +
        `If the current segment starts a distinct event, set event_boundary=true.`,
      );
    }
    if (options?.currentEventSummary || options?.recentSegmentSummaries?.length) {
      const wmLines: string[] = [];
      wmLines.push(`Current event summary before this segment: ${options.currentEventSummary || "(none)"}`);
      if (options.recentSegmentSummaries?.length) {
        wmLines.push(`Recent segment summaries, newest last:\n${options.recentSegmentSummaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n")}`);
      }
      wmLines.push("Use these only as continuity context for references, event continuity, and boundary decisions. Do not copy prior-context-only facts into detailed_summary.");
      wmLines.push("Output event_summary as the updated natural-language description of the current event after this segment, under 100 words.");
      wmLines.push("Title consistency: if this segment continues the current event, keep the same stable title category across adjacent similar segments. Change title only when event_boundary=true or the main activity type clearly changes.");
      wmLines.push("Set event_boundary=true when this segment starts a distinct title card, program section, location, interview subject, sport/play sequence, or unrelated visual/narration topic.");
      wmLines.push("If event_boundary=true, event_summary must describe the new event starting from this segment, not the previous event.");
      wmLines.push("Natural-language ID rule: never mention track_id in summary, detailed_summary, or event_summary. Use stable entity_id annotations only when explicitly provided.");
      wmLines.push("Entity ID rule for event_summary: use only stable entity_id values explicitly provided in input targets; never use track_id as entity_id.");
      contextParts.push(`Working memory for current event:\n${wmLines.join("\n")}`);
    }

    // Inject dialogue lines from STT (matches the reference dialogue_lines_json format)
    if (options?.localModelResults?.sttTranscript) {
      contextParts.push(`Dialogue / narration transcript (may carry the primary information — summarize what is being said, not just what is visually shown):\n${options.localModelResults.sttTranscript}`);
      if (options.localModelResults.hasSpeakerDiarization) {
        // Diarization path: attach speaker ids directly to main_targets.
        contextParts.push(
          `The transcript above has distinct speakers from audio diarization (speaker_0, speaker_1, etc.).\n` +
          `Attach each confident speaker_id to the corresponding visible main_targets entry using speaker_ids: ["speaker_0"].\n` +
          `Each distinct speaker_id represents a different person: never map two different speaker_id values to the same visible target/person. If a distinct speaker cannot be confidently mapped to a different visible target, omit it from speaker_ids.\n` +
          `If a speaker has current-segment real-person name evidence, put it in that same target as identity with the appropriate source. Use weak dialogue sources for uncertain spoken names.\n` +
          this.identityEvidenceInstruction(liveLatency),
        );
      } else {
        // Non-diarization path: transcript informs understanding only. The
        // pipeline preserves transcript lines as unknown-speaker dialogue.
        contextParts.push(
          `Use the transcript to understand spoken content and current-segment name evidence. Put real-person name evidence inside the corresponding target.identity with the appropriate source strength.\n` +
          this.identityEvidenceInstruction(liveLatency),
        );
      }
    }

    // Inject local subject evidence into prompt. The option key is retained as
    // `tracks` for compatibility, but these are segment-local subject labels.
    const targetData = this.buildTargetData(options?.localModelResults);
    if (targetData.length > 0) {
      const hasDisplacement = targetData.some(t => t.displacement_px);
      const knownEntityIds = this.collectKnownEntityIds(options?.localModelResults);
      contextParts.push(
        `Detected subjects from local models (describe only these subjects; copy track_id exactly in main_targets):\n` +
        JSON.stringify(targetData, null, 2) +
        `\n\nSubject/entity rules:\n` +
        `- track_id is a temporary per-segment subject label (e.g. cluster_0 or kf2_P1). Use it only in main_targets.track_id.\n` +
        `- Labels starting with "kf" (e.g. kf2_P1) are drawn on keyframe images as Set-of-Mark annotations. Refer to the annotated bboxes to identify which target each label points to.\n` +
        `- Do NOT write track_id in summary, detailed_summary, event_summary, custom_fields, or any other natural-language field.\n` +
        `- Never format a track_id as (entity_id=...).\n` +
        `- Only write (entity_id=...) in event_summary for stable IDs explicitly present in target.entity_id.\n` +
        `- Stable entity IDs available now: ${knownEntityIds.size > 0 ? [...knownEntityIds].join(", ") : "(none)"}. If this is (none), event_summary must contain no entity_id annotation.\n` +
        `- For non-face targets (kf*_P*, kf*_V*, kf*_A*): if "Previously seen anonymous subjects" are listed in context, compare current targets visually with the provided crops. If matched, set matched_anonymous_subject_id to the anonymous ID and match_confidence to 0-1. If no match, leave matched_anonymous_subject_id as null.` +
        (hasDisplacement
          ? `\nNote: "displacement_px" shows the bbox center shift in pixels from the first to the last frame within this segment. Values may include detection noise. Use them alongside the visual evidence to judge whether a target is actually moving.`
          : ""),
      );
    }

    // Inject segment policy exit condition check when an active escalation is ongoing.
    if (options?.segmentPolicyExitPrompt) {
      contextParts.push(
        `IMPORTANT — Active security escalation exit check:\n` +
        `${options.segmentPolicyExitPrompt}\n` +
        `Based on what you see in the current frames, has this exit condition been met? ` +
        `Set segment_policy_exit_met to true if the condition is clearly satisfied, false otherwise.`,
      );
    }

    // ── Intelligence directives (only when Semantic Context declares them) ──

    if (options?.trackStates?.length) {
      contextParts.push(
        `Track the following object states and report them in custom_fields:\n` +
        options.trackStates.map(s => `- ${s}`).join("\n"),
      );
    }

    if (options?.trackActivities?.length) {
      contextParts.push(
        `Report the primary current activity as custom_fields.current_activity, ` +
        `choosing from: ${options.trackActivities.join(", ")}.`,
      );
    }

    if (options?.hasAnomalyBaseline) {
      contextParts.push(
        `The Semantic Context above contains the scene's normal patterns (daily routine, known entities, anomaly baseline). ` +
        `If the current observation deviates from those patterns, highlight the deviation in your summary.`,
      );
    }

    if (hasReferenceFrame) {
      contextParts.push(
        `The FIRST image is a user-provided reference frame showing the expected/normal state of the scene. ` +
        `Compare the remaining frames against it and note any differences in your summary.`,
      );
    }

    return contextParts.length > 0
      ? `${basePrompt}\n\n${contextParts.join("\n")}`
      : basePrompt;
  }

  private withLiveLatencyPromptContract(prompt: string): string {
    return prompt
      .replace(SINGLE_FRAME_MAIN_TARGETS_OFFLINE, SINGLE_FRAME_MAIN_TARGETS_LIVE)
      .replace(MULTI_FRAME_MAIN_TARGETS_OFFLINE, MULTI_FRAME_MAIN_TARGETS_LIVE)
      .replace(
        `\n\n${SINGLE_FRAME_RETRIEVAL_HEADING}`,
        `\n\n${SINGLE_FRAME_TARGET_DETAILS_AND_RETRIEVAL}`,
      )
      .replace(
        `\n\n${MULTI_FRAME_RETRIEVAL_HEADING}`,
        `\n\n${MULTI_FRAME_TARGET_DETAILS_AND_RETRIEVAL}`,
      )
      .replace(SINGLE_FRAME_FIELD_ORDER_OFFLINE, SINGLE_FRAME_FIELD_ORDER_LIVE)
      .replace(MULTI_FRAME_FIELD_ORDER_OFFLINE, MULTI_FRAME_FIELD_ORDER_LIVE);
  }

  private eventContextUpdateInstruction(): string {
    return `event_context_update is optional and non-critical. When useful, output only: ` +
      `{ "setting": "<short stable scene/program background>", "participant_updates": [{ "role": "<stable role>", "visual_hints": "<stable visual placement/appearance>" }] }. ` +
      `setting should capture stable program/scene facts such as broadcast/web-video format, interview/panel structure, recurring camera cuts, and stable participant count/arrangement when clear. ` +
      `participant_updates are event-level participants. Do not include target_id, wm_target_id, D{id}, entity_id, dialogue, behavior, or long text.`;
  }

  private liveLatencyCriticalFieldInstruction(targetField: "main_targets" | "targets"): string {
    return `Critical field requirements:
  - Always output title, summary, security_risk, is_static_scene, notify_user, matched_rule_ids, best_frame_index, ${targetField}, and event_boundary as explicit top-level fields.
  - best_frame_index is required: output the 0-based index of the single most information-dense representative input frame. Use 0 when there is only one frame.
  - Start the JSON with this exact critical-field skeleton and choose values from the current segment:
  {"title":"<2-3 words>","summary":"<sentence>","security_risk":true/false,"is_static_scene":true/false,"notify_user":true/false,"matched_rule_ids":["<rule_id>"],"best_frame_index":<0-based integer>,"${targetField}":[...],"event_boundary":true/false}
  - Use false for security_risk, is_static_scene, and notify_user when the condition is not present.
  - Use [] for matched_rule_ids when no user rule matches.
  - Use [] for ${targetField} when there are no trackable subjects.
  - Do not delay these fields for descriptive appearance/behavior text.`;
  }

  private subjectProposalOutputFields(options: VlmSegmentAnalyzeOptions, aggregateTargets: boolean): string[] {
    const liveLatency = options.runtimeMode === "live_latency";
    void aggregateTargets;
    if (liveLatency) {
      return [
        "title",
        "summary",
        "security_risk",
        "is_static_scene",
        "notify_user",
        "matched_rule_ids",
        "best_frame_index",
        "targets",
        "event_boundary",
        "security_reason",
        "detailed_summary",
        "retrieval_compact",
        "event_summary",
        "event_context_update",
        "target_details",
        "segment_policy_exit_met",
        "content_type",
        "key_modality",
        "custom_fields",
      ];
    }
    return [
      "targets",
      "title",
      "summary",
      "detailed_summary",
      "security_risk",
      "security_reason",
      "notify_user",
      "matched_rule_ids",
      "retrieval_compact",
      "content_type",
      "key_modality",
      "is_static_scene",
      "event_boundary",
      "event_summary",
      "event_context_update",
      "custom_fields",
    ];
  }

  private subjectProposalOutputContract(options: VlmSegmentAnalyzeOptions, aggregateTargets: boolean): string {
    const liveLatency = options.runtimeMode === "live_latency";
    const fields = this.subjectProposalOutputFields(options, aggregateTargets);
    const lines = [
      "Output contract:",
      "- Return valid JSON only.",
      `- Use this top-level field order: ${fields.join(", ")}.`,
      "- Hard length limits: title 2-3 words, summary <=15 words, detailed_summary <=60 words, event_summary <=100 words, retrieval_compact <=8 short phrases. These limits are mandatory; write clear natural-language video descriptions and avoid unnecessary detail rather than exceeding them.",
    ];
    if (liveLatency) {
      lines.push(this.liveLatencyCriticalFieldInstruction("targets"));
    } else {
      lines.push("- Output fields may follow task order: targets first, then narrative/detail fields.");
      lines.push("- Include appearance/behavior directly in each target.");
    }
    lines.push("- Never mention D{id}, track_id, or internal target identifiers in summary, detailed_summary, event_summary, title, or retrieval_compact.");
    lines.push("- Do not copy prior-context-only facts into this segment; use prior context only for continuity, reference resolution, and boundary decisions.");
    lines.push(`- ${this.eventContextUpdateInstruction()}`);
    return lines.join("\n");
  }

  private subjectProposalInputOverview(aggregateTargets: boolean): string {
    return [
      "Inputs:",
      "- Video frames from the current segment. Use visible actions, object states, relative positions, scene changes, readable text, and final visible outcomes.",
      ...(aggregateTargets
        ? [
          "- Labeled person/animal D{id} detections are drawn directly on the frames. Use visible D{id} labels as evidence references for key subjects; D{id}s are local to this segment.",
          "- Current Segment Evidence may include machine candidate links from ReID or working memory, and may truncate long groups. Treat those links as hints only. The frames are authoritative for visible subjects.",
        ]
        : [
          "- Target aggregation is disabled for this call. Do not output D{id}s or perform cross-segment target matching.",
        ]),
      "- Dialogue or narration transcript may be provided. Use it to understand spoken information, speaker-target relationships, names, and outcomes.",
      "- Semantic Context and Current Event Story may be provided. Use them for continuity and reference resolution, but do not copy prior-only facts into this segment.",
    ].join("\n");
  }

  private subjectProposalTaskFlow(aggregateTargets: boolean, liveLatency: boolean): string {
    const lines = [
      "Task:",
      "Understand this video segment in the context of the ongoing event. Explain what happened, who or what matters, visible behavior, dialogue, scene changes, user-rule matches, and what should be remembered from this segment.",
      "",
      "Task flow:",
    ];
    if (aggregateTargets) {
      lines.push("1. First understand the segment event from the frames, dialogue, rules, and prior context: actions, interactions, spoken information, scene changes, continuity, and outcomes.");
      lines.push("2. From that event understanding, identify the small set of key people or animals that actually matter to this segment. Focus on foreground subjects, speakers, interacting/persistent subjects, safety/security-relevant subjects, and subjects referenced by dialogue or rules.");
      lines.push("3. For each key subject, decide whether the visible subject continues a Current Event Story participant. Use visual continuity, stable crops, position/appearance, and current frames; treat ReID links as hints and do not decide continuity from names, roles, topic, or summary-level identity alone.");
      lines.push("4. After continuity is decided, select representative D{id}s that show that same physical subject. Treat D{id}s as evidence for the already-identified subject, not as a checklist to exhaustively group every detection.");
      lines.push("5. Only after continuity and D{id}s are consistent, attach current-segment identity/name evidence to that target when the evidence belongs to those selected D{id}s.");
      lines.push("6. Decide title, summary, security_risk, notify_user, is_static_scene, event_boundary, and best_frame_index.");
      lines.push(liveLatency
        ? "7. Finally write detailed_summary, retrieval_compact, event_summary, event_context_update, target_details, and custom_fields as requested by the output contract."
        : "7. Finally write detailed_summary, retrieval_compact, event_summary, event_context_update, and custom_fields as requested by the output contract.");
    } else {
      lines.push("1. First use the visual frames, dialogue, rules, and prior context to understand the segment event: actions, interactions, spoken information, scene changes, continuity, and outcomes.");
      lines.push("2. Decide title, summary, security_risk, notify_user, is_static_scene, event_boundary, and best_frame_index.");
      lines.push("3. Finally write detailed_summary, retrieval_compact, event_summary, event_context_update, and custom_fields as requested by the output contract.");
    }
    return lines.join("\n");
  }

  private subjectProposalFieldDefinitions(liveLatency: boolean, aggregateTargets: boolean): string {
    const lines = [
      "Field definitions:",
      "- title: stable 2-3 word Title Case noun phrase for the segment card. Format only: no punctuation, no sentence, no names, no timestamps, no camera names, no confidence/status words. Describe the primary observable event type. For a continuing event, keep the same title category across adjacent similar segments; change it only when the event clearly changes.",
      "- summary: one-sentence description of what happens in this segment, max 15 words.",
      "- detailed_summary: fluent natural-language description of THIS segment only, max 60 words. Use prior context only to resolve references and continuity; do not copy prior-context-only facts into detailed_summary. When important text, numbers, scores, timers, progress, or results are visible/readable, preserve the exact concise values. Preserve salient identifying visual attributes such as clothing color/pattern, object color/state, visible labels, screen/UI state, and relative positions. When a visible or spoken action has an immediate visible or spoken outcome in THIS segment, mention both the action and the outcome; do not infer outcomes that are not visible or said.",
      "- content_type: \"surveillance\" | \"lecture\" | \"conversation\" | \"activity\" | \"sports\" | \"other\".",
      "- key_modality: \"visual\" | \"audio\" | \"both\".",
      "- is_static_scene: true only when this segment contains no new meaningful visual, text, or audio information.",
      "- event_boundary: true only when this segment begins a new event, or when the current event has grown too broad to preserve its important video content in a natural event_summary under 100 words. Set true for a new title card, program section, location, interview subject, sport/play sequence, or unrelated visual/narration topic.",
      "- event_summary: single-line natural-language description of the current event after this segment, max 100 words. Preserve important text/numbers/scores/results, repeated-event progress, and durable navigation anchors such as proper names, places, short visible labels, exact numbers/scores/timers, and explicit outcomes. If event_boundary=true, describe the new event starting from this segment, not the previous event.",
      `- ${this.eventContextUpdateInstruction()}`,
      "- retrieval_compact: array of 3-8 short phrases, each <=8 words, with concrete retrieval anchors from THIS segment only: exact visible text/numbers, distinctive objects, clothing, action-outcome pairs, proper names, places, and audio topic keywords. Do not include a full transcript, generic scene labels, D{id}, track_id, or prior-context-only facts.",
    ];
    if (aggregateTargets) {
      lines.push(
        liveLatency
          ? "- targets: key current-segment people/animals selected from visible D{id} evidence. Each target contains tid, type, bbox_ids, matched_wm_target, optional identity, and optional speaker_ids; appearance/behavior are deferred to target_details."
          : "- targets: key current-segment people/animals selected from visible D{id} evidence. Each target contains type, bbox_ids, matched_wm_target, optional identity, optional speaker_ids, behavior, and appearance when needed.",
      );
      if (liveLatency) {
        lines.push(
          "- tid: live-latency only temporary target correlation id. Use it only to match targets[] with target_details[] inside the same JSON response. It is not a stable identity and must be unique per target.",
          "- target_details: live-latency only array of descriptive fields for targets. Each entry must use tid matching one targets[].tid; appearance/behavior from target_details cannot be matched safely when tid is missing or duplicated.",
        );
      }
      lines.push(
        "- target.identity: optional current-segment person-name evidence for this target, attached only after continuity is decided and bbox_ids refer to one consistent physical subject. matched_wm_target may be null for a new subject. Include name, evidence, and source. Confirmed sources are visible_nameplate, self_introduction, direct_address_response, and dialogue_about_visible_person; weak hint sources are spoken, direct_address, third_person_reference, dialogue_about_person, and visible_text.",
        "- target.speaker_ids: optional array of STT diarization speaker ids, such as [\"speaker_0\"], that belong to this visible target. Only use when the transcript includes speaker ids. Different speaker_id values are different people; never assign two distinct speaker ids to the same target unless the transcript itself is clearly erroneous.",
      );
    }
    lines.push(
      "- security_risk, security_reason, notify_user, matched_rule_ids, and custom_fields follow the same meanings as the main VLM path; omit optional fields when not relevant.",
      "- best_frame_index: 0-based index of the single most information-dense representative input frame. Prefer clear faces, readable text, decisive action/outcome, or the final meaningful state.",
    );
    return lines.join("\n");
  }

  private collectKnownEntityIds(results?: LocalModelResults): Set<string> {
    const ids = new Set<string>();
    for (const track of results?.tracks ?? []) {
      if (track.entity_id) ids.add(track.entity_id);
    }
    return ids;
  }

  private buildTargetData(results?: LocalModelResults): Array<Record<string, unknown>> {
    return (results?.tracks ?? []).map((track) => {
      const target: Record<string, unknown> = {
        track_id: track.track_id,
        class_name: track.class_name,
      };
      if (track.keyframe_idx != null) target.keyframe_idx = track.keyframe_idx;
      if (track.keyframe_bbox) target.keyframe_bbox = track.keyframe_bbox;
      if (track.entity_id) target.entity_id = track.entity_id;
      if (track.is_new != null) target.is_new = track.is_new;
      if (track.history_behavior) target.history_behavior = track.history_behavior;
      if (track.prior_appearance) target.prior_appearance = track.prior_appearance;
      if (track.prior_behavior) target.prior_behavior = track.prior_behavior;
      if (track.displacement_px) target.displacement_px = track.displacement_px;
      return target;
    });
  }

  anonymousContextImages(context?: VlmAnalyzeOptions["anonymousSubjectContext"]): CompletionImage[] | undefined {
    if (!context?.length) return undefined;
    return context.map((subj) => ({
      base64: subj.crop_base64,
      label: `[${subj.anonymous_subject_id}] (${subj.class_name}): ${subj.appearance}`,
    }));
  }

  wmTargetImages(targets?: Array<{
    target_id: string;
    class_name: string;
    appearance: string;
    behavior?: string;
    identity?: {
      name: string;
      evidence?: string;
    };
    crop_base64?: string;
    crop_base64s?: string[];
  }>, options?: { includeBehavior?: boolean }): CompletionImage[] | undefined {
    if (!targets?.length) return undefined;
    const images = targets
      .flatMap((target) => {
        const crops = target.crop_base64s?.length ? target.crop_base64s : target.crop_base64 ? [target.crop_base64] : [];
        if (crops.length === 0) return [];
        const labelDetails = this.formatWmTargetDetails(target, options);
        return crops.slice(0, 2).map((crop, index) => ({
          base64: crop,
          label: labelDetails
            ? `[${target.target_id}${crops.length > 1 ? `#${index + 1}` : ""}] (${target.class_name}): ${labelDetails}`
            : `[${target.target_id}${crops.length > 1 ? `#${index + 1}` : ""}] (${target.class_name})`,
        }));
      });
    return images.length > 0 ? images : undefined;
  }

  private formatWmTargetDetails(target: {
    appearance?: string;
    behavior?: string;
    identity?: {
      name?: string;
      evidence?: string;
    };
  }, options?: { includeBehavior?: boolean }): string {
    const parts: string[] = [];
    const name = target.identity?.name?.trim();
    if (name) parts.push(`name=${name}`);
    const appearance = target.appearance?.trim();
    if (appearance) parts.push(`appearance=${appearance}`);
    const behavior = target.behavior?.trim();
    const evidence = target.identity?.evidence?.trim();
    if (options?.includeBehavior && behavior) parts.push(`behavior=${behavior}`);
    if (evidence) parts.push(`identity_evidence=${evidence}`);
    return parts.join("; ");
  }

  private parseCurrentEventContext(context?: string): {
    setting?: string;
    participants: string[];
    extraLines: string[];
  } {
    const participants: string[] = [];
    const extraLines: string[] = [];
    let setting: string | undefined;
    let inParticipants = false;
    for (const rawLine of context?.split(/\r?\n/) ?? []) {
      const line = rawLine.trim();
      if (!line) continue;
      const settingMatch = line.match(/^Setting:\s*(.+)$/i);
      if (settingMatch?.[1]?.trim()) {
        setting = settingMatch[1].trim();
        inParticipants = false;
        continue;
      }
      if (/^Participants:\s*$/i.test(line)) {
        inParticipants = true;
        continue;
      }
      if (inParticipants && line.startsWith("-")) {
        const participant = line.replace(/^-\s*/, "").trim();
        if (participant) participants.push(participant);
        continue;
      }
      inParticipants = false;
      extraLines.push(line);
    }
    return { setting, participants, extraLines };
  }

  private buildSemanticContextSection(options: VlmSegmentAnalyzeOptions): string | undefined {
    const lines: string[] = [];
    if (this.promptContext.sceneDescription && !options.suppressSceneDescription) {
      lines.push(`- Camera scene: ${this.promptContext.sceneDescription}`);
    }
    if (options.sceneContext?.trim()) {
      lines.push(`- Source/session context:\n${options.sceneContext.trim()}`);
    }
    if (lines.length === 0) return undefined;
    return [
      "Semantic Context:",
      "This is source-level context and user/session background. It is not necessarily current-segment evidence.",
      ...lines,
    ].join("\n");
  }

  private buildCurrentEventStorySection(options: VlmSegmentAnalyzeOptions, liveLatency: boolean): string | undefined {
    const eventContext = this.parseCurrentEventContext(options.currentEventContext);
    const hasSpokenNameHints = options.subjectProposal?.wmTargets?.some((target) => target.identity_hints?.length);
    const lines: string[] = [
      "Current Event Story:",
      "This is working-memory context for the ongoing event before this segment. Use it for continuity and reference resolution only.",
      "Stable Participants are historical candidates, not a checklist. They may or may not appear now; do not force-match them to background people.",
      "Stable Participant known_name/recent_behavior/history fields describe prior continuity context. Use them for story continuity after visual matching is clear; they are not current-segment name evidence by themselves.",
    ];
    if (hasSpokenNameHints) {
      lines.push("spoken_name_hints are unconfirmed prior dialogue clues; use them only with current supporting evidence, never as identity by themselves.");
    }

    if (eventContext.setting) {
      lines.push("Setting:");
      lines.push(`- ${eventContext.setting}`);
    }
    if (options.currentEventSummary?.trim()) {
      lines.push("Event summary before this segment:");
      lines.push(`- ${options.currentEventSummary.trim()}`);
    }

    if (eventContext.participants.length > 0) {
      lines.push("Event Participants:");
      lines.push(...eventContext.participants.map((participant) => `- ${participant}`));
    }

    const participantLines = this.buildCurrentEventParticipantLines(options, liveLatency);
    if (participantLines.length > 0) {
      lines.push("Stable Participants / Matching Hints:");
      lines.push(...participantLines);
    }

    if (options.recentSegmentSummaries?.length) {
      lines.push("Recent flow:");
      lines.push(...options.recentSegmentSummaries.map((summary, index) => `${index + 1}. ${summary}`));
    }
    if (eventContext.extraLines.length > 0) {
      lines.push("Additional event state:");
      lines.push(...eventContext.extraLines.map((line) => `- ${line}`));
    }

    const hasStoryContent = hasSpokenNameHints
      || Boolean(eventContext.setting)
      || eventContext.participants.length > 0
      || eventContext.extraLines.length > 0
      || Boolean(options.currentEventSummary?.trim())
      || participantLines.length > 0
      || Boolean(options.recentSegmentSummaries?.length);
    if (!hasStoryContent) return undefined;
    return lines.join("\n");
  }

  private buildCurrentEventParticipantLines(
    options: VlmSegmentAnalyzeOptions,
    _liveLatency: boolean,
  ): string[] {
    const targets = options.subjectProposal?.wmTargets ?? [];
    const lines: string[] = [];
    for (const target of targets) {
      const details: string[] = [];
      const className = target.class_name?.trim();
      const name = target.identity?.name?.trim();
      if (name) details.push(`known_name=${name}`);
      const appearance = target.appearance?.trim();
      if (appearance) details.push(`appearance=${appearance}`);
      const behavior = target.behavior?.trim();
      if (behavior) details.push(`recent_behavior=${behavior}`);
      const history = target.history_behavior?.trim();
      if (history) details.push(`history=${history}`);
      if (target.entity_id?.trim()) details.push(`entity=${target.entity_id.trim()}`);
      if (target.continuity_strength?.trim()) details.push(`continuity=${target.continuity_strength.trim()}`);
      const evidence = target.identity?.evidence?.trim();
      if (evidence && !target.entity_id?.trim()) details.push(`identity_evidence=${evidence}`);
      const hintTexts = target.identity_hints
        ?.map((hint) => {
          const hintName = hint.name?.trim();
          if (!hintName) return undefined;
          const source = hint.source?.trim();
          const hintEvidence = hint.evidence?.trim();
          return `${hintName}${source ? `/${source}` : ""}${hintEvidence ? `: ${hintEvidence}` : ""}`;
        })
        .filter((hint): hint is string => Boolean(hint))
        .slice(-3);
      if (hintTexts?.length) details.push(`spoken_name_hints=${hintTexts.join(" | ")}`);
      if (details.length === 0) continue;
      const parts = className ? [className, ...details] : details;
      lines.push(`- [${target.target_id}] ${parts.join("; ")}`);
    }
    return lines;
  }


  // ── Private: subject proposal prompt section ──

  buildSubjectProposalPrompt(
    didContext: string,
    options: VlmSegmentAnalyzeOptions,
  ): string {
    const sections: string[] = [];
    const aggregateTargets = options.subjectProposal?.targetAggregation !== "disabled";
    const liveLatency = options.runtimeMode === "live_latency";
    const hasPreviousTargets = aggregateTargets && !!options.subjectProposal?.wmTargets?.length;

    sections.push(
      `You are analyzing one video segment as part of an ongoing event. First understand what is happening in this segment and how it continues or changes the current event story.
Use the current frames and transcript as the source of truth. Semantic Context and Current Event Story are background for continuity and reference resolution only.${aggregateTargets ? " After understanding the event, identify only the key visible subjects needed to explain this segment. D{id} labels and machine ReID links are evidence hints after a subject is understood; they are not the source of truth for who the subject is." : ""}

  ${this.subjectProposalInputOverview(aggregateTargets)}`,
    );

    const semanticContext = this.buildSemanticContextSection(options);
    if (semanticContext) sections.push(semanticContext);

    const currentEventStory = this.buildCurrentEventStorySection(options, liveLatency);
    if (currentEventStory) sections.push(currentEventStory);

    const currentSegmentEvidenceParts: string[] = [];
    if (aggregateTargets) {
      currentSegmentEvidenceParts.push(didContext);
    }
    if (options.localModelResults?.sttTranscript) {
      currentSegmentEvidenceParts.push(`Dialogue / narration transcript:\n${options.localModelResults.sttTranscript}`);
    }
    if (aggregateTargets && options.subjectProposal?.wmTargets?.some((t) => !!t.crop_base64 || !!t.crop_base64s?.length)) {
      currentSegmentEvidenceParts.push("Stable participant crop images follow before the current frames. Each crop is a visual reference for its labeled wm_target. Use these crops only to decide whether a current visible subject continues that participant. If the visual match is uncertain, set matched_wm_target to null. Do not match a participant to a background person just because the role, name, topic, or ReID candidate seems related.");
    }
    if (currentSegmentEvidenceParts.length > 0) {
      sections.push(
        `Current Segment Evidence:\nThe following evidence belongs only to THIS segment. Use it to understand the current visible subjects, update the story, and attach evidence pointers only when they clearly belong to the same subject.\n${currentSegmentEvidenceParts.join("\n\n")}`,
      );
    }

    sections.push(this.subjectProposalTaskFlow(aggregateTargets, liveLatency));

    const taskInstructionParts: string[] = [];
    if (this.promptContext.focusTargets) {
      taskInstructionParts.push(`Pay extra attention to: ${this.promptContext.focusTargets}`);
    }
    if (this.promptContext.securityRules) {
      taskInstructionParts.push(`Security rules: ${this.promptContext.securityRules}`);
    }
    if (this.promptContext.userRules) {
      taskInstructionParts.push(`User-defined rules (use these to refine your analysis):\n${this.promptContext.userRules}`);
    }

    if (options.localModelResults?.sttTranscript && aggregateTargets) {
      if (options.localModelResults.hasSpeakerDiarization) {
        // Diarization path: transcript already has speaker_0, speaker_1, etc.
        // Ask VLM to attach speaker ids directly to targets instead of per-line attribution.
        taskInstructionParts.push(
          `**Speaker Identity Mapping** (the transcript above has distinct speakers from audio diarization):\n` +
          `Attach each confident speaker_id (speaker_0, speaker_1, etc.) to the corresponding visible target using target.speaker_ids.\n` +
          `Each distinct speaker_id represents a different person: never map two different speaker_id values to the same visible target/person. If a distinct speaker cannot be confidently mapped to a different visible target, leave that speaker unknown by omitting it from target.speaker_ids.\n` +
          `Use visual cues: lip movement, gesturing while speaking, facing camera/audience, body language.\n` +
          `If a speaker has current-segment real-person name evidence, put it in that same target.identity with the appropriate source strength. Only include speakers that can be confidently mapped to a visible target.\n` +
          this.identityEvidenceInstruction(liveLatency),
        );
      } else {
        // Non-diarization path (Moonshine): transcript informs understanding
        // only. The pipeline keeps transcript lines as unknown-speaker dialogue.
        taskInstructionParts.push(
          `**Speaker & Identity Attribution** (because dialogue transcript is present):\n` +
          `Use the transcript to understand spoken content and current-segment name evidence.\n` +
          `Put real-person name evidence inside the corresponding target.identity with the appropriate source strength. Do not output a top-level dialogue field.\n` +
          this.identityEvidenceInstruction(liveLatency),
        );
      }
    }

    if (options.currentEventSummary || options.recentSegmentSummaries?.length) {
      taskInstructionParts.push("Use Current Event Story only for references, event continuity, and boundary decisions. Do not copy prior-context-only facts into detailed_summary.");
      taskInstructionParts.push("Title consistency: if this segment continues the current event, keep the same stable title category across adjacent similar segments. Change title only when event_boundary=true or the main activity type clearly changes.");
      taskInstructionParts.push("Set event_boundary=true when this segment starts a distinct title card, program section, location, interview subject, sport/play sequence, or unrelated visual/narration topic.");
    }

    if (options.segmentPolicyExitPrompt) {
      taskInstructionParts.push(
        `IMPORTANT — Active security escalation exit check:\n` +
        `${options.segmentPolicyExitPrompt}\n` +
        `Based on what you see in the current frames, has this exit condition been met? ` +
        `Set segment_policy_exit_met to true if the condition is clearly satisfied, false otherwise.`,
      );
    }

    if (options.trackStates?.length) {
      taskInstructionParts.push(
        `Track the following object states and report them in custom_fields:\n` +
        options.trackStates.map(s => `- ${s}`).join("\n"),
      );
    }

    if (options.trackActivities?.length) {
      taskInstructionParts.push(
        `Report the primary current activity as custom_fields.current_activity, ` +
        `choosing from: ${options.trackActivities.join(", ")}.`,
      );
    }

    if (options.hasAnomalyBaseline) {
      taskInstructionParts.push(
        `The Semantic Context above contains the scene's normal patterns (daily routine, known entities, anomaly baseline). ` +
        `If the current observation deviates from those patterns, highlight the deviation in your summary.`,
      );
    }
    if (taskInstructionParts.length > 0) {
      sections.push(`Task instructions:\n${taskInstructionParts.join("\n")}`);
    }

    const wmMatchingRules = hasPreviousTargets
      ? `- Stable Participants are optional continuity candidates. Use matched_wm_target only when the current visible subject is clearly the same visual subject; otherwise use null.
  - matched_wm_target must be exactly one listed participant id or null. Never invent ids, never force-match absent participants, and never match a participant to a background person.`
      : `- Set matched_wm_target to null for every target. Do not perform cross-segment target matching in this call.`;

    sections.push(
      aggregateTargets
        ? `Subject selection rules:
  - Understand the segment first, then identify only the key visible subjects needed to explain it. Skip incidental background people.
  - Match a subject to a Stable Participant only when visual continuity is clear; otherwise use matched_wm_target=null.
  - After choosing a subject, attach only representative D{id}s that clearly show that same subject. Treat D{id}s and machine ReID links as evidence hints, not the definition of the subject.
  - Describe the visible subject itself. Attach identity only when this segment clearly links a name to that subject.
  ${wmMatchingRules}
Output constraints:
  - Each D{id} can belong to at most one target.
  - bbox_ids must be exact D<number> strings and are local to this segment.
  - Do not output entity_id.
  - If a subject has no reliable D{id}, mention it in summary/detailed_summary but omit it from targets.
  - When targets exist, each target entry must contain: ${liveLatency ? "tid, " : ""}type, bbox_ids, matched_wm_target${liveLatency ? "." : ", behavior. Include appearance for new targets and for prior wmTarget matches only when the appearance visibly changed."}
  ${liveLatency ? "- For each target, include a unique tid such as \"t1\". Put descriptive fields in target_details. target_details describes the visible subject represented by the target, not the D{id} list or machine entity group." : ""}`
        : `Subject selection rules:
  - Do not identify targets, do not output D{id}s, and do not perform target matching.
  - Describe only what is visible or said in THIS segment; use prior context only for continuity.
  - Do not mention internal labels, detection boxes, target ids, or entity ids.
  - Return "targets": [].`,
    );

    sections.push(this.subjectProposalFieldDefinitions(liveLatency, aggregateTargets));
    sections.push(this.subjectProposalOutputContract(options, aggregateTargets));

    return sections.join("\n\n");
  }

}
