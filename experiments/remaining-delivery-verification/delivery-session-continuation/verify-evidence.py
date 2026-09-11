#!/usr/bin/env python3
"""Recompute paired target metrics and verify phase occupancy from saved observations."""
import argparse,collections,datetime,hashlib,json,math,pathlib,statistics
ap=argparse.ArgumentParser();ap.add_argument("evidence",type=pathlib.Path);a=ap.parse_args();p=a.evidence
read=lambda n:json.loads((p/n).read_text())
sha=lambda b:hashlib.sha256(b).hexdigest()
for side in ["red","green"]:
 for target in ["host","identity"]:
  receipt=read(target+"-"+side+".json");log=(p/(target+"-"+side+".log")).read_bytes()
  assert sha(log)==receipt["logSha256"]
  assert receipt["exitCode"]==(1 if side=="red" else 0)
for target in ["host","identity"]:assert read(target+"-red.json")["args"]==read(target+"-green.json")["args"]
comparison=read("comparison.json");medians={}
for side in ["red","green"]:
 rows=[json.loads(line[len("RECOVERY_RESULT "):]) for line in (p/("host-"+side+".log")).read_text().splitlines() if line.startswith("RECOVERY_RESULT ")]
 assert len(rows)==3 and all(r["ready"] and r["result"]["exitCode"]==124 for r in rows)
 assert sum(r["descendantCompleted"] for r in rows)==(3 if side=="red" else 0)
 medians[side]=statistics.median(r["elapsedMs"] for r in rows)
 assert math.isclose(medians[side],comparison["recovery"][side]["medianReturnMs"],abs_tol=1e-8)
 rows=[json.loads(line[len("LEGACY_RESULT "):]) for line in (p/("identity-"+side+".log")).read_text().splitlines() if line.startswith("LEGACY_RESULT ")]
 assert len(rows)==1 and rows[0]==comparison["identity"][side]
 assert rows[0]["exitCode"]==(0 if side=="red" else 1)
 if side=="green":assert rows[0]["stdout"]=="" and "IMPLEMENTATION_SESSION_ENTRY_REFUSED" in rows[0]["stderr"]
reduction=100*(1-medians["green"]/medians["red"])
assert math.isclose(reduction,comparison["returnLatencyReductionPercent"],abs_tol=1e-9)
def ts(value):return datetime.datetime.fromisoformat(value.replace("Z","+00:00")).timestamp()
def union(intervals):
 total=0;end=None
 for left,right in sorted(intervals):
  if right<=left:continue
  if end is None or left>end:total+=right-left;end=right
  elif right>end:total+=right-end;end=right
 return total
assert union([(0,5),(3,9),(9,11),(1,2),(12,13)])==12
phase=read("story-phase-attribution.json")
source=(p/"activity-selected.jsonl").read_bytes();source_manifest=read("activity-selected-manifest.json")
assert sha(source)==source_manifest["sha256"]
activity=[json.loads(line) for line in source.splitlines()]
for story in phase["stories"]:
 sid=story["storyId"];start=ts(story["windowStart"]);end=ts(story["windowEnd"])
 index=read("story-census/"+sid+".stdout")["index"]
 events=sorted((ts(e["timestamp"]),e["phase"]) for e in index["events"] if e.get("action") in ["create","advance"] and e.get("timestamp") and ts(e["timestamp"])<=end)
 segments=[]
 for i,(left,name) in enumerate(events):
  right=events[i+1][0] if i+1<len(events) else end
  if min(right,end)>max(left,start):segments.append([max(left,start),min(right,end),name])
 assert segments==story["segments"]
 # Ignore test-source activity: synthetic assertions are not real owner work.
 rows=[r for r in activity if r.get("storyId")==sid and r.get("source")!="test" and r.get("startTime") and r.get("endTime") and ts(r["startTime"])<=end and ts(r["endTime"])>=start]
 assert len(rows)==story["commandCount"],(sid,len(rows),story["commandCount"])
 for name,values in story["phases"].items():
  spans=[(l,r) for l,r,n in segments if n==name];occupancy=sum(r-l for l,r in spans)
  observed=union([(max(l,ts(row["startTime"])),min(r,ts(row["endTime"]))) for row in rows for l,r in spans])
  assert math.isclose(occupancy,values["stateOccupancySeconds"],abs_tol=1e-4),(sid,name,"occupancy")
  assert math.isclose(observed,values["observedCommandUnionSeconds"],abs_tol=1e-4),(sid,name,"command-union",observed,values)
  assert math.isclose(occupancy-observed,values["unclassifiedSeconds"],abs_tol=1e-4)
 for failure in story["repeatedExactFailures"]:
  pointers={(x["source"],x["line"]) for x in failure["sourceRows"]}
  matches=[r for r in rows if (r["_source"],r["_line"]) in pointers]
  assert len(matches)==failure["calls"]
  assert all(r["tool"]==failure["command"] and r.get("error")==failure["error"] for r in matches)
  duration=union([(max(start,ts(r["startTime"])),min(end,ts(r["endTime"]))) for r in matches])
  assert math.isclose(duration,failure["unionSeconds"],abs_tol=1e-4)
print(json.dumps({"verdict":"PASS","timeoutReturnMedianMs":medians,"returnLatencyReductionPercent":reduction,"storyPhaseObservationsVerified":len(phase["stories"]),"limitation":"Phase occupancy and uncovered intervals do not establish review labor, queue time, waste or overall Story speedup."},indent=2))
