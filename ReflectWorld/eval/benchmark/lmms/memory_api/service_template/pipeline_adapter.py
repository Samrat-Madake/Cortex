import re
from typing import Any, Dict, List, Optional, Tuple


class PipelineAdapter:
    """Adapter layer to your existing stateful video-memory pipeline.

    Replace `build_state` and `answer_question` with your own implementation.
    """

    def __init__(self, dry_run: bool = True):
        self.dry_run = dry_run

    def build_state(
        self,
        video_id: str,
        visual_paths: List[str],
        model: Optional[str],
        generation_kwargs: Dict[str, Any],
        metadata: Dict[str, Any],
    ) -> Any:
        if self.dry_run:
            # Minimal placeholder state for endpoint smoke tests.
            return {
                "video_id": video_id,
                "visual_paths": visual_paths,
                "model": model,
            }

        # Integration hook: call your existing long-video pipeline here.
        # Example:
        #   return my_pipeline.get_or_build_memory(
        #       video_id=video_id,
        #       video_path=visual_paths[0] if visual_paths else None,
        #       config=generation_kwargs,
        #   )
        raise NotImplementedError("Implement build_state() with your pipeline integration.")

    def answer_question(
        self,
        state: Any,
        prompt: str,
        generation_kwargs: Dict[str, Any],
        metadata: Dict[str, Any],
    ) -> Tuple[str, Optional[Dict[str, int]]]:
        if self.dry_run:
            # Deterministic dry-run behavior: choose first option letter seen in prompt.
            m = re.search(r"(^|\\n)\\s*([A-H])\\.\\s", prompt)
            answer = m.group(2) if m else "A"
            usage = {
                "prompt_tokens": len(prompt.split()),
                "completion_tokens": 1,
                "reasoning_tokens": 0,
            }
            return answer, usage

        # Integration hook: call your agent over the built state here.
        # Example:
        #   raw_answer = my_pipeline.answer(state=state, question=prompt)
        #   return raw_answer, None
        raise NotImplementedError("Implement answer_question() with your pipeline integration.")
