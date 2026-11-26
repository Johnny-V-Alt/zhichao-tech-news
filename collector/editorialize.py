"""Source-grounded editorial analysis. Scoring/time/publication are Node-owned.

Reuses TrendRadar AIClient, prompt loader, JSON decoder and existing atomic I/O.
No credentials or no opt-in => no model request and no invented digest.
"""
from __future__ import annotations

import argparse
import json
import re
import uuid
from datetime import datetime
from pathlib import Path

from collect import APP, atomic_json, now
from process_content import digest
from trendradar.ai.filter import AIFilter
from trendradar.ai.prompt_loader import load_prompt_template

IMPLEMENTATION = digest(Path(__file__).read_text(encoding="utf-8"))[:12]
DIMENSIONS = ["relevance", "evidence", "impact", "novelty"]
TOPICS = {"ai","hardware","systems","software","networks","databases","security","research","industry","ai_science"}


class Rejected(ValueError): pass
class BudgetExceeded(RuntimeError): pass


class Decoder(AIFilter):
    def __init__(self): pass


def require(value, message):
    if not value: raise Rejected(message)


def parse_json(response):
    try:
        parsed = json.loads(Decoder()._extract_json(response) or "null")
    except (ValueError,TypeError): raise Rejected("invalid_model_json") from None
    require(isinstance(parsed,dict),"model_object_required")
    return parsed


def cite(citation, unit):
    require(isinstance(citation,dict),"invalid_citation")
    quote = citation.get("quote")
    require(isinstance(quote,str) and 0 < len(quote.encode("utf-16-le"))//2 <= 250,"invalid_quote")
    source = next((a for a in unit["articles"] if a["id"]==citation.get("article_id")),None)
    require(source and source["content_status"] in {"full_text","source_summary"} and quote in (source.get("content_text") or ""),"quote_not_in_source")


def claim_rows(a):
    return ([{"claim_id":f"fact:{i}","claim":c} for i,c in enumerate(a["facts"])]+
            [{"claim_id":f"change:{i}","claim":c} for i,c in enumerate(a["changes"])]+
            [{"claim_id":"significance","claim":a["significance"]}]+
            [{"claim_id":"score:"+key,"claim":a["scores"][key]["reason"]} for key in DIMENSIONS])


def dates(text):
    return [f"{y}-{int(m):02d}-{int(d):02d}" for y,m,d in re.findall(r"(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?",text)]


def numeric_tokens(text):
    text = re.sub(r"(?<=\d),(?=\d{3}\b)","",text).replace("−","-")
    return re.findall(r"(?<![A-Za-z0-9])-?\d+(?:\.\d+)*",text)


def quantities(text):
    return [re.sub(r"\s","",m) for m in re.findall(r"\d+(?:\.\d+)?\s*(?:gb|tb|mb|nm|%|美元|元|倍|ms|秒|小时|watts?)",text.lower())]


def validate_assessment(a, unit, checker_required=False):
    require(a.get("content_type") in {"news","tutorial","knowledge","tool","review","unknown"},"invalid_type")
    require(a.get("technology_relevance") in {"relevant","out_of_scope","uncertain"},"invalid_relevance")
    require(isinstance(a.get("topics"),list) and all(isinstance(t,str) and t in TOPICS for t in a["topics"]),"invalid_topics")
    require(a.get("verification") in {"source_report","vendor_claim","conflicting","unverified"},"invalid_verification")
    require(isinstance(a.get("facts"),list) and 1<=len(a["facts"])<=4 and isinstance(a.get("changes"),list) and len(a["changes"])<=2,"invalid_facts")
    require(all(isinstance(c,dict) and c.get("inference") is not True for c in a["facts"]+a["changes"]),"facts_cannot_be_inferences")
    for key in DIMENSIONS:
        score = a.get("scores",{}).get(key,{})
        require(type(score.get("value")) in (int,float) and 0<=score["value"]<=5,"invalid_dimension_score")
    for row in claim_rows(a):
        claim = row["claim"]
        require(isinstance(claim,dict) and isinstance(claim.get("text"),str) and 0 < len(claim["text"].encode("utf-16-le"))//2 <=600,"invalid_claim")
        require("inference" not in claim or type(claim["inference"]) is bool,"invalid_inference_flag")
        require(isinstance(claim.get("citations"),list) and 1<=len(claim["citations"])<=4,"missing_claim_citations")
        for c in claim["citations"]: cite(c,unit)
        quoted="\n".join(c["quote"] for c in claim["citations"])
        require(set(numeric_tokens(claim["text"]))<=set(numeric_tokens(quoted)),"unsupported_numeric_claim")
        require(set(quantities(claim["text"]))<=set(quantities(quoted)),"unsupported_quantity")
    event_date=a.get("event_date")
    require("event_date" in a,"missing_event_date_state")
    if event_date is not None:
        cite(event_date.get("citation"),unit)
        require(event_date.get("value") in dates(event_date["citation"]["quote"]),"unsupported_event_date")
        datetime.strptime(event_date["value"],"%Y-%m-%d")
    if checker_required:
        expected={c["claim_id"] for c in claim_rows(a)}
        checks=a.get("checker",{}).get("checks")
        require(isinstance(checks,list) and len(checks)==len(expected),"incomplete_checker")
        for row in checks:
            require(isinstance(row,dict) and row.get("claim_id") in expected and row.get("supported") is True and isinstance(row.get("reason"),str) and 0<len(row["reason"])<=1000,"checker_rejected_claim")
            expected.remove(row["claim_id"])


class RequestBudget:
    def __init__(self, client, policy):
        self.client,self.policy=client,policy
        self.metrics={"calls":0,"writer_calls":0,"checker_calls":0,"estimated_token_upper_bound":0,"actual_usage_available":False}

    def call(self, role, messages):
        # UTF-8 bytes plus framing/output reserve is a deliberately conservative
        # budget bound, not a claimed usage/billing measurement.
        bound=sum(len(m["content"].encode("utf-8")) for m in messages)+128+self.policy["max_output_tokens"]
        if self.metrics["calls"]>=self.policy["max_calls_per_run"] or self.metrics["estimated_token_upper_bound"]+bound>self.policy["estimated_token_upper_limit"]:
            raise BudgetExceeded("request_budget_exhausted")
        self.metrics["calls"]+=1
        self.metrics[role+"_calls"]+=1
        self.metrics["estimated_token_upper_bound"]+=bound
        try:
            return self.client.chat(messages,max_tokens=self.policy["max_output_tokens"],timeout=self.policy["timeout_seconds"],num_retries=0)
        except Exception as error:
            raise Rejected("model_request_failed:"+type(error).__name__) from None


def prompt(name, field, value):
    system,user=load_prompt_template(str(APP/"config"/name),label="Editorial")
    require(bool(system and user),"missing_prompt")
    return [{"role":"system","content":system},{"role":"user","content":user.replace("{"+field+"}",json.dumps(value,ensure_ascii=False))}]


def analyze(unit, budget, policy):
    sources=[a for a in unit["articles"] if a.get("content_text") and a["content_status"] in {"full_text","source_summary"}][:4]
    share=min(policy["context_chars_per_article"],policy["max_context_chars_per_item"]//max(1,len(sources)))
    materials=[{"article_id":a["id"],"title":a["title"],"published_at":a["published_at"],"content_status":a["content_status"],"content_text":a["content_text"][:share]} for a in sources]
    # A quote's presence is only structural validation. A separate source-
    # consistency pass is required before anything can enter publication.
    raw=parse_json(budget.call("writer",prompt("editorial-writer.txt","materials",materials)))
    a={key:raw.get(key) for key in ["content_type","technology_relevance","topics","verification","facts","changes","significance","scores","event_date"]}
    validate_assessment(a,unit)
    checker_input=[]
    for row in claim_rows(a):
        checker_input.append({"claim_id":row["claim_id"],"text":row["claim"]["text"],"inference":row["claim"].get("inference",False),"citations":row["claim"]["citations"]})
    checked=parse_json(budget.call("checker",prompt("editorial-checker.txt","claims",checker_input)))
    a["checker"]={"checks":checked.get("checks")}
    validate_assessment(a,unit,checker_required=True)
    return a


def build_run(snapshot, client=None, unavailable_state="not_configured"):
    policy=snapshot["policy"]
    prompt_hash=digest("".join((APP/"config"/name).read_text(encoding="utf-8") for name in ["editorial-writer.txt","editorial-checker.txt"]))[:12]
    endpoint_fingerprint=digest(getattr(client,"api_base","") or "default")[:12] if client else "unconfigured"
    version=f"{policy['version']}:{IMPLEMENTATION}:{prompt_hash}:{endpoint_fingerprint}"
    model=getattr(client,"model","fixture/model") if client else ""
    run={"schema_version":1,"run_id":digest(uuid.uuid4().hex),"snapshot_id":snapshot["snapshot_id"],"policy_hash":snapshot["policy_hash"],
         "analysis_version":version,"model":model,"generated_at":now(),"state":unavailable_state,"analyses":[],"reused_analysis_ids":[],"pending":[],"errors":[],
         "metrics":{"calls":0,"writer_calls":0,"checker_calls":0,"estimated_token_upper_bound":0,"actual_usage_available":False}}
    queue=sorted([u for u in snapshot["units"] if u["preflight"]["candidate"]],key=lambda u:(u["preflight"]["age_hours"] or 0,u["id"]))
    if not snapshot["processing_ready"]:
        run["state"]="processing_required";run["pending"]=[{"unit_id":u["id"],"reason":"processing_required"} for u in queue];return run
    if client is None:
        run["pending"]=[{"unit_id":u["id"],"reason":unavailable_state} for u in queue]
        return run
    budget=RequestBudget(client,policy["ai"])
    cached={r["analysis_id"]:r for r in snapshot["cache"]}
    attempted=0
    for unit in queue:
        key=digest(f"{unit['id']}:{unit['input_hash']}:{version}:{model}")
        if key in cached:
            run["reused_analysis_ids"].append(key);continue
        if attempted>=policy["ai"]["max_items_per_run"]:
            run["pending"].append({"unit_id":unit["id"],"reason":"next_batch"});continue
        attempted+=1
        try:
            assessment=analyze(unit,budget,policy["ai"])
            run["analyses"].append({"analysis_id":key,"unit_id":unit["id"],"input_hash":unit["input_hash"],"analysis_version":version,"model":model,"assessment":assessment})
        except BudgetExceeded:
            run["pending"].append({"unit_id":unit["id"],"reason":"request_budget_exhausted"})
        except Exception as error:
            code=str(error) if isinstance(error,Rejected) else "analysis_validation_failed:"+type(error).__name__
            run["errors"].append({"unit_id":unit["id"],"code":code})
            run["pending"].append({"unit_id":unit["id"],"reason":"analysis_failed"})
    run["metrics"]=budget.metrics
    run["state"]="partial_error" if run["errors"] and run["analyses"] else "failed" if run["errors"] else "budget_limited" if run["pending"] else "completed"
    return run


def main():
    import os
    parser=argparse.ArgumentParser()
    parser.add_argument("--input",type=Path,default=APP/"data"/"editorial"/"input.json")
    parser.add_argument("--output",type=Path,default=APP/"data"/"editorial"/"output.json")
    args=parser.parse_args()
    snapshot=json.loads(args.input.read_text(encoding="utf-8-sig"))
    client,state=None,"not_configured"
    if os.environ.get("AI_API_KEY") and os.environ.get("AI_MODEL"):
        state="disabled"
        if snapshot["policy"]["ai"]["enabled"] or os.environ.get("EDITORIAL_AI_ENABLED")=="1":
            from trendradar.ai.client import AIClient
            client=AIClient({"MODEL":os.environ["AI_MODEL"],"API_KEY":os.environ["AI_API_KEY"],"API_BASE":os.environ.get("AI_API_BASE",""),"TEMPERATURE":0,"MAX_TOKENS":snapshot["policy"]["ai"]["max_output_tokens"],"TIMEOUT":snapshot["policy"]["ai"]["timeout_seconds"],"NUM_RETRIES":0})
    result=build_run(snapshot,client,state)
    atomic_json(args.output,result)
    print(json.dumps({"run_id":result["run_id"],"state":result["state"],"new_analyses":len(result["analyses"]),"reused":len(result["reused_analysis_ids"]),"pending":len(result["pending"]),"errors":result["errors"],"metrics":result["metrics"]},ensure_ascii=False,indent=2))


if __name__ == "__main__": main()
