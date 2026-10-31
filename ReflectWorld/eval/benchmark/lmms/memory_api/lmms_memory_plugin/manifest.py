from lmms_eval.models.registry_v2 import ModelManifest


def get_manifests():
    return [
        ModelManifest(
            model_id="memory_api",
            simple_class_path="lmms_memory_plugin.memory_api.MemoryAPI",
        )
    ]
