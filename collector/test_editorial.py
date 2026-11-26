import copy
import json
from pathlib import Path

import pytest
from editorialize import Rejected, build_run, claim_rows, validate_assessment
from collect import now

POLICY=json.loads((Path(__file__).parents[1]/"config"/"editorial.json").read_text(encoding="utf-8"))
SOURCE="ExampleLang 4.0 was released on 2026-11-26. It improves networking and remains in preview. "+"Technical source text and limitations. "*5


def unit():
    return {"id":"article:a","input_hash":"b"*64,"articles":[{"id":"a","title":"ExampleLang release","canonical_url":"https://example.com/a","content_text":SOURCE,"content_status":"full_text","published_at":"2026-11-26T00:00:00Z"}],
            "preflight":{"candidate":True,"reason":"ready","age_hours":1},"curation":None,"dedup_keys":["a"]}


def snapshot():
    return {"snapshot_id":"c"*64,"policy_hash":"d"*64,"policy":copy.deepcopy(POLICY),"units":[unit()],"cache":[],"processing_ready":True}


def assessment():
    c={"article_id":"a","quote":"ExampleLang 4.0 was released on 2026-11-26. It improves networking and remains in preview."}
    reason={"text":"材料描述了软件与网络技术。","citations":[c]}
    return {"content_type":"news","technology_relevance":"relevant","topics":["software","networks"],"verification":"source_report",
            "facts":[{"text":"软件发布了预览版本。","citations":[c]}],"changes":[],"significance":{"text":"网络开发者可以关注这次变化。","citations":[c],"inference":True},
            "scores":{key:{"value":5,"reason":reason} for key in ["relevance","evidence","impact","novelty"]},"event_date":None}


class FakeClient:
    model="fixture/model"
    def __init__(self, writer=None, supported=True, fail=False): self.writer=writer or assessment();self.supported=supported;self.fail=fail;self.calls=[]
    def chat(self,messages,**kwargs):
        self.calls.append(messages)
        if self.fail: raise RuntimeError("SECRET_API_KEY should not be logged")
        if len(self.calls)%2:
            return json.dumps(self.writer)
        return json.dumps({"checks":[{"claim_id":row["claim_id"],"supported":self.supported,"reason":"Synthetic source check"} for row in claim_rows(self.writer)]})


def test_missing_model_makes_no_calls_and_generates_no_assessment():
    result=build_run(snapshot())
    assert result["state"]=="not_configured"
    assert not result["analyses"] and result["metrics"]["calls"]==0
    assert result["pending"][0]["reason"]=="not_configured"


def test_requires_fresh_processing_before_analysis():
    data=snapshot();data["processing_ready"]=False
    client=FakeClient()
    result=build_run(data,client)
    assert result["state"]=="processing_required" and not client.calls


def test_writer_and_checker_are_both_required_and_estimates_are_explicit():
    client=FakeClient()
    result=build_run(snapshot(),client)
    assert result["state"]=="completed" and len(result["analyses"])==1
    assert result["metrics"]["calls"]==2 and result["metrics"]["actual_usage_available"] is False
    assert result["metrics"]["estimated_token_upper_bound"]>0
    assert result["analyses"][0]["assessment"]["checker"]["checks"]


def test_negative_checker_result_does_not_create_an_analysis():
    result=build_run(snapshot(),FakeClient(supported=False))
    assert result["state"]=="failed" and not result["analyses"]
    assert "checker_rejected_claim" in result["errors"][0]["code"]


@pytest.mark.parametrize("text",["新版本是 8.0。","吞吐提高了 16GB。","变化为 -4.0。"])
def test_unquoted_numbers_units_and_negative_numbers_are_rejected(text):
    a=assessment();a["facts"][0]["text"]=text
    with pytest.raises(Rejected): validate_assessment(a,unit())


def test_fabricated_quote_is_rejected_before_checker_call():
    a=assessment();a["facts"][0]["citations"][0]["quote"]="Fabricated quote"
    client=FakeClient(a)
    result=build_run(snapshot(),client)
    assert result["state"]=="failed" and len(client.calls)==1


def test_writer_cannot_supply_its_own_checker_or_publication_flag():
    a=assessment();a["checker"]={"checks":[{"supported":True}]};a["published"]=True;a["state"]="completed"
    result=build_run(snapshot(),FakeClient(a,supported=False))
    assert not result["analyses"]


def test_call_and_token_budgets_stop_further_requests():
    data=snapshot();data["policy"]["ai"]["max_calls_per_run"]=1
    client=FakeClient();result=build_run(data,client)
    assert result["state"]=="budget_limited" and len(client.calls)==1 and not result["analyses"]
    data=snapshot();data["policy"]["ai"]["estimated_token_upper_limit"]=1
    client=FakeClient();result=build_run(data,client)
    assert result["metrics"]["calls"]==0 and not client.calls


def test_current_content_analysis_cache_avoids_repeat_model_calls():
    data=snapshot();first=build_run(data,FakeClient())
    data["cache"]=first["analyses"]
    client=FakeClient(fail=True);again=build_run(data,client)
    assert again["state"]=="completed" and not client.calls
    assert again["reused_analysis_ids"]==[first["analyses"][0]["analysis_id"]]


def test_model_failure_is_sanitized_and_never_turns_into_a_summary():
    result=build_run(snapshot(),FakeClient(fail=True))
    assert result["state"]=="failed" and not result["analyses"]
    assert "SECRET_API_KEY" not in json.dumps(result)


def test_title_only_and_background_candidates_are_not_sent_for_summary():
    data=snapshot();data["units"][0]["preflight"]={"candidate":False,"reason":"insufficient_content","age_hours":0}
    client=FakeClient();result=build_run(data,client)
    assert not client.calls and not result["analyses"]


def test_event_date_requires_a_full_explicit_date_in_the_source():
    a=assessment();a["event_date"]={"value":"2026-10-01","citation":{"article_id":"a","quote":"It improves networking and remains in preview."}}
    with pytest.raises(Rejected): validate_assessment(a,unit())


def test_item_batch_limit_and_multi_source_context_are_bounded():
    data=snapshot();data["policy"]["ai"]["max_items_per_run"]=1
    other=copy.deepcopy(data["units"][0]);other["id"]="article:b";other["input_hash"]="e"*64
    data["units"].append(other)
    client=FakeClient();result=build_run(data,client)
    assert len(result["analyses"])==1 and len(client.calls)==2 and result["state"]=="budget_limited"
    data=snapshot();data["units"][0]["articles"]*=4
    data["units"][0]["articles"][0]["content_text"]=SOURCE*50
    client=FakeClient();build_run(data,client)
    prompt=client.calls[0][1]["content"]
    materials=json.loads(prompt.split("分析这些材料：",1)[1])
    assert sum(len(m["content_text"]) for m in materials)<=data["policy"]["ai"]["max_context_chars_per_item"]


def test_inference_is_not_allowed_to_masquerade_as_a_fact():
    a=assessment();a["facts"][0]["inference"]=True
    with pytest.raises(Rejected): validate_assessment(a,unit())
