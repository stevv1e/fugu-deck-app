from app.config import Settings
from app.llm import Usage
from evals.harness_eval import cost_of, load_tasks, offline


async def test_offline_harness_baseline_is_reproducible():
    report = await offline()
    assert report["routing"]["passed"] == report["routing"]["total"] == len(load_tasks())
    assert report["routing"]["accuracy"] == 1
    context = report["context_fixture"]
    assert context["map_chars"] < context["full_chars"]
    assert context["symbol_chars"] < context["map_chars"]
    assert 0 < context["symbol_reduction"] < 1


def test_live_eval_cost_uses_existing_model_pricing(tmp_path):
    settings = Settings(data_dir=tmp_path)
    usage = Usage(prompt_tokens=1000, completion_tokens=500, cached_tokens=200, cache_write_tokens=100)
    assert cost_of(settings, "sakana:fugu-max-v1.0", usage) > 0
    assert cost_of(settings, "sakana:fugu-max-v1.0", None) == 0
