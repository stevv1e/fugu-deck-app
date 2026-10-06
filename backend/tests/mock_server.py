"""Тестовый сервер: имитирует Sakana (OpenAI-совместимый стриминг) и часть GitHub API.

Запуск: uvicorn tests.mock_server:app --port 9100
"""
import json
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()
STATE = {"commits": [], "blobs": {}, "refs": {"main": "sha-main-0"}, "requests": []}


def chunk(delta: dict, finish=None, usage=None):
    d = {"id": "c1", "object": "chat.completion.chunk", "created": int(time.time()), "model": "fugu-max-v1.0",
         "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        d = {**d, "choices": [], "usage": usage}
    return f"data: {json.dumps(d)}\n\n"


@app.post("/v1/chat/completions")
async def completions(req: Request):
    body = await req.json()
    STATE["requests"].append(body)
    msgs = body["messages"]
    tools_done = [m for m in msgs if m["role"] == "tool"]
    last_user = [m for m in msgs if m["role"] == "user"][-1]

    text_user = last_user["content"] if isinstance(last_user["content"], str) else last_user["content"][0]["text"]
    last_is_tool = msgs[-1]["role"] == "tool"

    def one_call(name, args):
        yield chunk({"tool_calls": [{"index": 0, "id": f"call_{uuid.uuid4().hex[:6]}", "type": "function",
                                     "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]})
        yield chunk({}, finish="tool_calls")

    def gen():
        if "запомни" in text_user.lower() or "вспомни" in text_user.lower() or "скил" in text_user.lower():
            if not last_is_tool:
                if "запомни" in text_user.lower():
                    yield from one_call("memory_save", {"content": text_user.split(":", 1)[-1].strip(), "tags": "infra"})
                elif "вспомни" in text_user.lower():
                    yield from one_call("memory_search", {"query": "docker"})
                else:
                    yield from one_call("load_skill", {"name": "conventional-commits"})
            else:
                yield chunk({"content": "OK: " + msgs[-1]["content"][:300]})
                yield chunk({}, finish="stop")
            yield chunk({}, usage={"prompt_tokens": 500, "completion_tokens": 50, "total_tokens": 550})
            yield "data: [DONE]\n\n"
            return
        if not tools_done:
            yield chunk({"role": "assistant", "content": "Смотрю ваши репозитории… "})
            args = json.dumps({"provider": "github", "limit": 5})
            yield chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                         "function": {"name": "list_repos", "arguments": args[:10]}}]})
            yield chunk({"tool_calls": [{"index": 0, "function": {"arguments": args[10:]}}]})
            yield chunk({}, finish="tool_calls")
        elif len(tools_done) == 1:
            args = json.dumps({"provider": "github", "repo": "me/demo", "branch": "feature/hello",
                               "base_branch": "main", "message": "feat: add hello",
                               "files": [{"path": "hello.py", "content": "print('hi')\n"}]})
            yield chunk({"tool_calls": [{"index": 0, "id": "call_2", "type": "function",
                                         "function": {"name": "commit_files", "arguments": args}}]})
            yield chunk({}, finish="tool_calls")
        else:
            res = tools_done[-1]["content"]
            for part in ["Готово! ", "Результат: ", res[:200]]:
                yield chunk({"content": part})
            yield chunk({}, finish="stop")
        yield chunk({}, usage={"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200,
                               "prompt_tokens_details": {"cached_tokens": 400}})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ------------------------------------------------ fake GitHub
@app.get("/gh/user")
async def gh_user():
    return {"login": "me", "name": "Me", "html_url": "https://github.com/me"}


@app.get("/gh/user/repos")
async def gh_repos():
    return [{"full_name": "me/demo", "private": True, "default_branch": "main", "description": "demo",
             "html_url": "https://github.com/me/demo", "pushed_at": "2026-09-01"}]


@app.get("/gh/repos/{o}/{r}")
async def gh_repo(o: str, r: str):
    return {"full_name": f"{o}/{r}", "private": True, "default_branch": "main", "html_url": "x"}


@app.get("/gh/repos/{o}/{r}/branches")
async def gh_branches(o: str, r: str):
    return [{"name": b} for b in STATE["refs"]]


@app.get("/gh/repos/{o}/{r}/git/ref/heads/{branch:path}")
async def gh_ref(o: str, r: str, branch: str):
    from fastapi import HTTPException
    if branch not in STATE["refs"]:
        raise HTTPException(404, "Not Found")
    return {"object": {"sha": STATE["refs"][branch]}}


@app.post("/gh/repos/{o}/{r}/git/refs")
async def gh_create_ref(o: str, r: str, req: Request):
    b = await req.json()
    STATE["refs"][b["ref"].removeprefix("refs/heads/")] = b["sha"]
    return {"ref": b["ref"]}


@app.patch("/gh/repos/{o}/{r}/git/refs/heads/{branch:path}")
async def gh_update_ref(o: str, r: str, branch: str, req: Request):
    STATE["refs"][branch] = (await req.json())["sha"]
    return {}


@app.get("/gh/repos/{o}/{r}/git/commits/{sha}")
async def gh_commit(o: str, r: str, sha: str):
    return {"sha": sha, "tree": {"sha": "tree-" + sha}}


@app.post("/gh/repos/{o}/{r}/git/blobs")
async def gh_blob(o: str, r: str, req: Request):
    sha = uuid.uuid4().hex
    STATE["blobs"][sha] = await req.json()
    return {"sha": sha}


@app.post("/gh/repos/{o}/{r}/git/trees")
async def gh_tree(o: str, r: str, req: Request):
    STATE["last_tree"] = await req.json()
    return {"sha": "newtree"}


@app.post("/gh/repos/{o}/{r}/git/commits")
async def gh_new_commit(o: str, r: str, req: Request):
    b = await req.json()
    STATE["commits"].append(b)
    return {"sha": f"commit{len(STATE['commits'])}"}


@app.get("/state")
async def get_state():
    return {k: v for k, v in STATE.items() if k != "requests"} | {"n_requests": len(STATE["requests"]),
                                                                    "last_request_msgs": STATE["requests"][-1]["messages"] if STATE["requests"] else None}


# ------------------------------------------------ fake Anthropic Messages API
def aev(type_, **data):
    return f"event: {type_}\ndata: {json.dumps({'type': type_, **data}, ensure_ascii=False)}\n\n"


@app.post("/anthropic/v1/messages")
async def anthropic_messages(req: Request):
    from fastapi.responses import JSONResponse
    body = await req.json()
    STATE.setdefault("anthropic_requests", []).append(body)
    if req.headers.get("x-api-key") != "sk-ant-test":
        return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}, 401)
    msgs = body["messages"]
    last = msgs[-1]
    has_result = any(b.get("type") == "tool_result" for b in last["content"])
    if has_result:
        # как реальный API: при продолжении цикла инструментов thinking-блок должен вернуться без изменений
        prev = msgs[-2]
        th = [b for b in prev["content"] if b.get("type") == "thinking"]
        if not th or th[0].get("signature") != "sig-abc":
            return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                 "message": "thinking block with signature must be preserved"}}, 400)
    user_text = " ".join(b.get("text", "") for m in msgs if m["role"] == "user" for b in m["content"] if b.get("type") == "text")

    def gen():
        yield aev("message_start", message={"id": "msg_1", "type": "message", "role": "assistant", "content": [],
                                             "model": body["model"], "stop_reason": None, "stop_sequence": None,
                                             "usage": {"input_tokens": 900, "output_tokens": 1,
                                                       "cache_read_input_tokens": 300, "cache_creation_input_tokens": 100}})
        if not has_result:
            yield aev("content_block_start", index=0, content_block={"type": "thinking", "thinking": "", "signature": ""})
            yield aev("content_block_delta", index=0, delta={"type": "thinking_delta", "thinking": "Надо запомнить."})
            yield aev("content_block_delta", index=0, delta={"type": "signature_delta", "signature": "sig-abc"})
            yield aev("content_block_stop", index=0)
            yield aev("content_block_start", index=1, content_block={"type": "text", "text": ""})
            yield aev("content_block_delta", index=1, delta={"type": "text_delta", "text": "Сохраняю в память. "})
            yield aev("content_block_stop", index=1)
            args = json.dumps({"content": "Claude: " + user_text.split(":", 1)[-1].strip()[:80], "tags": "claude"}, ensure_ascii=False)
            yield aev("content_block_start", index=2, content_block={"type": "tool_use", "id": "toolu_01", "name": "memory_save", "input": {}})
            yield aev("content_block_delta", index=2, delta={"type": "input_json_delta", "partial_json": args[:12]})
            yield aev("content_block_delta", index=2, delta={"type": "input_json_delta", "partial_json": args[12:]})
            yield aev("content_block_stop", index=2)
            yield aev("message_delta", delta={"stop_reason": "tool_use", "stop_sequence": None}, usage={"output_tokens": 120})
        else:
            yield aev("content_block_start", index=0, content_block={"type": "text", "text": ""})
            yield aev("content_block_delta", index=0, delta={"type": "text_delta", "text": "Готово, запомнил (Claude)."})
            yield aev("content_block_stop", index=0)
            yield aev("message_delta", delta={"stop_reason": "end_turn", "stop_sequence": None}, usage={"output_tokens": 40})
        yield aev("message_stop")

    return StreamingResponse(gen(), media_type="text/event-stream")
