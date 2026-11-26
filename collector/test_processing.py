import copy
import json
from pathlib import Path

import pytest
from process_content import body_text, clean_title, classify_rules, digest, make_events, process_snapshot

CONFIG = json.loads((Path(__file__).parents[1]/"config"/"processing.json").read_text(encoding="utf-8"))


def article(aid, title, text="", date="2026-11-26T00:00:00+00:00", status="full_text"):
    return {"id":aid,"title":title,"canonical_url":f"https://example.com/{aid}","content_text":text or None,
            "content_status":status if text else "title_only","published_at":date,"publication_precision":"second" if date else "unknown",
            "kind":"tutorial","input_hash":digest([aid,title,text,date]),"content_sha256":digest(title+text),"sources":[]}


def snapshot(*articles):
    return {"snapshot_id":digest([a["input_hash"] for a in articles]),"articles":list(articles),"overrides":[],"events":[],"label_cache":{},"relation_cache":[]}


def test_cleaning_preserves_technical_identity_and_code_indentation():
    assert clean_title("  <b>C++</b>\n &amp; C# ") == "C++ & C#"
    assert clean_title("vector<T> and .NET 9") == "vector<T> and .NET 9"
    assert clean_title("GPT-5.1") != clean_title("GPT-5.2")
    assert body_text("if x:\n    call()\r\n") == "if x:\n    call()"
    assert digest(body_text("if x:\n call()")) != digest(body_text("if x:\n    call()"))


def test_types_come_from_article_and_topics_are_multiple():
    a = article("a","OpenAI 发布 AI 数学证明工具", "AI theorem proof with an open-source library")
    label = classify_rules(a,CONFIG)
    assert label["content_type"] == "news"
    assert "tool" in label["secondary_types"]
    assert {"ai","research","ai_science"} <= set(label["topics"])
    assert label["evidence"]
    unknown = classify_rules(article("b","An unclear headline"),CONFIG)
    assert unknown["content_type"] == "unknown"  # source kind says tutorial, but no inference from it
    assert unknown["status"] == "needs_review"


def test_same_body_is_a_separate_fingerprint_and_original_articles_survive():
    content = "Useful technical explanation of code and data.\n"*20
    a,b = article("a","Python tool released",content),article("b","A Python library review",content)
    # Different content types deliberately block automatic collapse.
    out = process_snapshot(snapshot(a,b),CONFIG)
    assert out["relations"][0]["decision"] == "pending"
    b["title"] = "Python tool released by another publisher"
    out = process_snapshot(snapshot(a,b),CONFIG)
    assert out["relations"][0]["kind"] == "duplicate"
    assert len(out["labels"]) == 2
    assert a["content_sha256"] != b["content_sha256"]


def test_identical_summaries_do_not_claim_identical_full_articles():
    text = "A repeated publisher summary. "*30
    out=process_snapshot(snapshot(article("a","Python tool released",text,status="source_summary"),article("b","Python tool released",text,status="source_summary")),CONFIG)
    assert all(r["kind"] != "duplicate" for r in out["relations"])


def test_cross_language_release_groups_by_verified_identifiers_and_date():
    a,b=article("a","OpenAI releases GPT-5.2"),article("b","OpenAI 推出 GPT-5.2")
    out=process_snapshot(snapshot(a,b),CONFIG)
    assert out["relations"][0]["kind"] == "same_event"
    assert out["events"][0]["article_ids"] == ["a","b"]


@pytest.mark.parametrize("left,right",[
    ("OpenAI releases GPT-5.1","OpenAI releases GPT-5.2"),
    ("NVIDIA releases RTX 5070","NVIDIA releases RTX 5080"),
    ("CVE-2026-12345 漏洞披露","CVE-2026-12346 漏洞披露"),
    ("NVIDIA releases RTX 5070 at $499","NVIDIA releases RTX 5070 at $599"),
    ("NVIDIA releases RTX 5070 16GB","NVIDIA releases RTX 5070 24GB"),
    ("OpenAI 发布 GPT-5.2","OpenAI 尚未发布 GPT-5.2")
])
def test_conflicting_identity_or_denial_does_not_merge(left,right):
    config=copy.deepcopy(CONFIG); config["candidate_title_score"]=40
    out=process_snapshot(snapshot(article("a",left),article("b",right)),config)
    assert out["relations"]
    assert all(r["decision"]=="pending" and r["guards"] for r in out["relations"])
    assert not out["events"]


def test_unknown_dates_and_shared_company_are_not_enough_to_merge():
    a,b=article("a","OpenAI releases GPT-5.2",date=None),article("b","OpenAI releases GPT-5.2")
    assert process_snapshot(snapshot(a,b),CONFIG)["relations"][0]["decision"]=="pending"
    a,b=article("a","OpenAI releases a new tool"),article("b","OpenAI releases another new tool")
    assert all(r["decision"]=="pending" for r in process_snapshot(snapshot(a,b),CONFIG)["relations"])
    a,b=article("a","OpenAI releases a new tool"),article("b","OpenAI 上线新的工具")
    out=process_snapshot(snapshot(a,b),CONFIG)
    assert len(out["relations"])==1 and out["relations"][0]["decision"]=="pending"


def test_release_of_a_benchmark_is_news_and_code_review_billing_is_not_a_review():
    assert classify_rules(article("a","UL 发布 CPU 游戏性能基准测试工具"),CONFIG)["content_type"] == "news"
    assert classify_rules(article("b","Copilot code review billing will default to the organization"),CONFIG)["content_type"] == "news"


def test_patch_is_a_directional_followup_and_bad_chronology_is_pending():
    a=article("a","CVE-2026-12345 漏洞披露",date="2026-11-25T00:00:00+00:00")
    b=article("b","修复 CVE-2026-12345 漏洞",date="2026-11-26T00:00:00+00:00")
    out=process_snapshot(snapshot(a,b),CONFIG)
    assert out["relations"][0]["kind"]=="follow_up"
    assert out["relations"][0]["followup_id"]=="b"
    assert not out["events"]
    b["published_at"]="2026-11-24T00:00:00+00:00"
    assert process_snapshot(snapshot(a,b),CONFIG)["relations"][0]["decision"]=="pending"


def test_complete_link_blocks_unproven_chain_merging():
    articles=[article(x,"Python发布") for x in "abc"]
    labels={a["id"]:{"content_type":"news"} for a in articles}
    relations=[{"left_id":"a","right_id":"b","kind":"same_event","decision":"accepted"},
               {"left_id":"b","right_id":"c","kind":"same_event","decision":"accepted"}]
    events=make_events(articles,labels,relations,[])
    assert [len(e["article_ids"]) for e in events]==[2]


class FakeClient:
    model="fixture/test-model"
    def __init__(self, response=None, fail=False): self.response,self.fail,self.calls=response,fail,0
    def chat(self,*_,**__):
        self.calls+=1
        if self.fail: raise RuntimeError("TOP_SECRET_KEY must not reach logs")
        return json.dumps(self.response)


def test_upstream_model_batching_accepts_evidenced_multitopic_labels_and_caches():
    a=article("a","Python PostgreSQL 实战", "Use Python and PostgreSQL to build an application.")
    client=FakeClient([{"id":1,"tag_id":2,"score":0.95,"topics":["software","databases"],"technology_relevance":"relevant","reason":"编程与数据库教程","evidence":[{"field":"title","quote":"实战"}]}])
    out=process_snapshot(snapshot(a),CONFIG,client)
    assert out["labels"][0]["method"]=="model"
    assert out["labels"][0]["topics"]==["software","databases"]
    data=snapshot(a); data["label_cache"]={"a":{"rules_version":out["rules_version"],"label":out["labels"][0]}}
    process_snapshot(data,CONFIG,client)
    assert client.calls==1


def test_hallucinated_evidence_or_api_failure_keeps_rules_and_hides_secrets(capsys):
    a=article("a","Python教程", "Source content")
    client=FakeClient([{"id":1,"tag_id":2,"score":0.99,"topics":["ai"],"technology_relevance":"relevant","reason":"made up","evidence":[{"field":"title","quote":"does not exist"}]}])
    assert process_snapshot(snapshot(a),CONFIG,client)["labels"][0]["method"]=="rules"
    out=process_snapshot(snapshot(a),CONFIG,FakeClient(fail=True))
    assert out["metrics"]["errors"]
    assert "TOP_SECRET_KEY" not in capsys.readouterr().out


def test_model_pair_uses_actual_quotes_and_reuses_cached_decision():
    config=copy.deepcopy(CONFIG); config["ai"]["max_classification_calls"]=0
    a,b=article("a","Acme releases a new compiler","Compiler implementation details. "*10),article("b","Acme releases a new compiler","New compiler release documentation. "*10)
    client=FakeClient([{"pair":0,"kind":"same_event","reason":"两篇材料描述同一次发布","evidence":[{"article_id":"a","field":"title","quote":"Acme"},{"article_id":"b","field":"title","quote":"Acme"}]}])
    out=process_snapshot(snapshot(a,b),config,client)
    assert out["relations"][0]["method"]=="model" and out["events"]
    data=snapshot(a,b); data["relation_cache"]=[{"relation":out["relations"][0],"left_hash":a["input_hash"],"right_hash":b["input_hash"],"rules_version":out["rules_version"]}]
    process_snapshot(data,config,client)
    assert client.calls==1


def test_manual_rejection_and_label_override_are_reversible_derived_data():
    a,b=article("a","OpenAI releases GPT-5.2"),article("b","OpenAI 推出 GPT-5.2")
    data=snapshot(a,b)
    baseline=process_snapshot(data,CONFIG)
    assert baseline["events"]
    data["overrides"]=[{"kind":"relation","left_id":"a","right_id":"b","value":{"kind":"not_related","reason":"人工核对不是同一次发布"}}]
    assert not process_snapshot(data,CONFIG)["events"]
    data["overrides"]=[]
    assert process_snapshot(data,CONFIG)["run_id"]==baseline["run_id"]


def test_manual_classification_is_not_sent_to_the_model_again():
    a=article("a","Python教程","Source body")
    data=snapshot(a)
    data["overrides"]=[{"kind":"label","article_id":"a","value":{"content_type":"knowledge","topics":["software"],"technology_relevance":"relevant","reason":"人工已核对"}}]
    client=FakeClient(fail=True)
    out=process_snapshot(data,CONFIG,client)
    assert client.calls==0 and out["labels"][0]["method"]=="manual"


def test_processing_id_is_stable_after_node_json_number_roundtrip():
    a=article("a","Unclear title")
    data=snapshot(a)
    first=process_snapshot(data,CONFIG)
    def js_number(text):
        number=float(text)
        return int(number) if number.is_integer() else number
    cached=json.loads(json.dumps(first["labels"][0]),parse_float=js_number)
    data["label_cache"]={"a":{"rules_version":first["rules_version"],"label":cached}}
    again=process_snapshot(data,CONFIG)
    assert again["metrics"]["rule_labels_reused"]==1
    assert first["run_id"]==again["run_id"]
    assert digest({"value":0.0})==digest({"value":0})
    assert digest({"value":"0.0"})!=digest({"value":0.0})
