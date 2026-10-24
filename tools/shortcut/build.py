#!/usr/bin/env python3
"""Builds the iPhone shortcut "Save to ShopMarx" and signs it (macOS, signed in to iCloud).

    python3 tools/shortcut/build.py

Writes extension/shortcut/Save to ShopMarx.shortcut, which the web app links to. The
shortcut is in the share sheet; it puts the shared link into Apps/ShopMarx/inbox/ in
Dropbox, and the next sync adds it (sync.js, takeInbox). It holds no secrets: the App key
and the sign-in token are asked for when it is added (the dashboard shows both).
"""

import plistlib
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "extension" / "shortcut" / "Save to ShopMarx.shortcut"
GAP = "￼"  # Where a variable goes in a text field.


def text(*parts):
    """A text field: plain strings and variables (dicts from output()) in a row."""
    string, attachments = "", {}
    for part in parts:
        if isinstance(part, str):
            string += part
        else:
            attachments[f"{{{len(string)}, 1}}"] = part
            string += GAP
    return {"Value": {"string": string, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}


def variable(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def dictionary(pairs):
    items = [{"WFItemType": 0, "WFKey": text(key), "WFValue": value if isinstance(value, dict) else text(value)} for key, value in pairs]
    return {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"}


actions = []


def action(identifier, name=None, **parameters):
    """Adds an action; returns a reference to its output."""
    output = str(uuid.uuid4()).upper()
    actions.append({"WFWorkflowActionIdentifier": identifier, "WFWorkflowActionParameters": {"UUID": output, **parameters}})
    return {"Type": "ActionOutput", "OutputUUID": output, "OutputName": name or "Output"}


# 0, 1: filled in when the shortcut is added (import questions below).
app_key = action("is.workflow.actions.gettext", "App key", WFTextActionText="")
token = action("is.workflow.actions.gettext", "Sign-in token", WFTextActionText="")
# The links in what was shared (a page, a link, or text with a link in it), one per line.
links = action("is.workflow.actions.detect.link", "URLs", WFInput=variable({"Type": "ExtensionInput"}))
body = action("is.workflow.actions.gettext", "Links", WFTextActionText=text(links))
# A short-lived access token from the long-lived one.
reply = action(
    "is.workflow.actions.downloadurl",
    "Token reply",
    WFURL="https://api.dropboxapi.com/oauth2/token",
    WFHTTPMethod="POST",
    WFHTTPBodyType="Form",
    WFFormValues=dictionary([("grant_type", "refresh_token"), ("refresh_token", text(token)), ("client_id", text(app_key))]),
)
access = action("is.workflow.actions.getvalueforkey", "Access token", WFDictionaryKey="access_token", WFInput=variable(reply))
action(
    "is.workflow.actions.downloadurl",
    "Upload reply",
    WFURL="https://content.dropboxapi.com/2/files/upload",
    WFHTTPMethod="POST",
    WFHTTPBodyType="File",
    WFRequestVariable=variable(body),
    WFHTTPHeaders=dictionary([
        ("Authorization", text("Bearer ", access)),
        ("Content-Type", "application/octet-stream"),
        ("Dropbox-API-Arg", '{"path":"/inbox/link.txt","mode":"add","autorename":true,"mute":true}'),
    ]),
)
action("is.workflow.actions.notification", WFNotificationActionTitle="ShopMarx", WFNotificationActionBody="Saved. It shows up after the next sync.")

shortcut = {
    "WFWorkflowClientVersion": "2607.0.3",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFSafariWebPageContentItem", "WFStringContentItem", "WFRichTextContentItem"],
    "WFWorkflowOutputContentItemClasses": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowImportQuestions": [
        {"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
         "Text": "Dropbox App key (ShopMarx: settings → Dropbox ⋯ → iPhone shortcut)"},
        {"ActionIndex": 1, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
         "Text": "Sign-in token (shown in the same place)"},
    ],
    "WFWorkflowActions": actions,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    unsigned = Path(tmp) / "unsigned.shortcut"
    unsigned.write_bytes(plistlib.dumps(shortcut, fmt=plistlib.FMT_BINARY))
    done = subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", str(unsigned), "--output", str(OUT)], capture_output=True, text=True)
    if done.returncode:
        sys.exit(f"Signing failed: {done.stderr.strip() or done.stdout.strip()}")
print(f"Wrote {OUT}")
