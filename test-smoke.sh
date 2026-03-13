#!/usr/bin/env bash
# test-smoke.sh — Smoke tests for browse-multi
set -e

BROWSE="node $(dirname "$0")/browse-multi.js"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo "  PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

echo "=== Browse-Multi Smoke Test ==="

# Test 1: Start instance and navigate
echo "Test 1: goto + url"
$BROWSE --name smoke1 goto https://example.com > /dev/null 2>&1
URL=$($BROWSE --name smoke1 url 2>/dev/null)
if echo "$URL" | grep -q "example.com"; then pass "goto + url"; else fail "goto + url: got $URL"; fi

# Test 2: text extraction
echo "Test 2: text"
TEXT=$($BROWSE --name smoke1 text 2>/dev/null)
if echo "$TEXT" | grep -qi "example domain"; then pass "text extraction"; else fail "text extraction"; fi

# Test 3: snapshot
echo "Test 3: snapshot"
SNAP=$($BROWSE --name smoke1 snapshot 2>/dev/null)
if echo "$SNAP" | grep -q "@e1"; then pass "snapshot refs"; else fail "snapshot refs"; fi

# Test 4: status
echo "Test 4: status"
STATUS=$($BROWSE status 2>/dev/null)
if echo "$STATUS" | grep -q "smoke1"; then pass "status shows instance"; else fail "status"; fi

# Test 5: Second concurrent instance
echo "Test 5: concurrent instance"
$BROWSE --name smoke2 goto https://example.com > /dev/null 2>&1
URL2=$($BROWSE --name smoke2 url 2>/dev/null)
if echo "$URL2" | grep -q "example.com"; then pass "concurrent instance"; else fail "concurrent instance"; fi

STATUS2=$($BROWSE status 2>/dev/null)
INSTANCE_COUNT=$(echo "$STATUS2" | grep -c "UP")
if [ "$INSTANCE_COUNT" -ge 2 ]; then pass "both instances running"; else fail "expected 2 instances, got $INSTANCE_COUNT"; fi

# Test 6: scroll
echo "Test 6: scroll"
$BROWSE --name smoke1 scroll > /dev/null 2>&1
if [ $? -eq 0 ]; then pass "scroll down"; else fail "scroll down"; fi

# Test 7: screenshot
echo "Test 7: screenshot"
SPATH=$($BROWSE --name smoke1 screenshot 2>/dev/null)
if [ -f "$SPATH" ]; then pass "screenshot created at $SPATH"; else fail "screenshot not created"; fi

# Test 8: js eval
echo "Test 8: js"
TITLE=$($BROWSE --name smoke1 js "document.title" 2>/dev/null)
if echo "$TITLE" | grep -qi "example"; then pass "js eval"; else fail "js eval: got $TITLE"; fi

# Test 9: tabs
echo "Test 9: tabs"
$BROWSE --name smoke1 newtab https://example.com > /dev/null 2>&1
TABS=$($BROWSE --name smoke1 tabs 2>/dev/null)
TAB_COUNT=$(echo "$TABS" | wc -l | tr -d ' ')
if [ "$TAB_COUNT" -ge 2 ]; then pass "multi-tab ($TAB_COUNT tabs)"; else fail "expected 2+ tabs, got $TAB_COUNT"; fi
$BROWSE --name smoke1 closetab 1 > /dev/null 2>&1

# Test 10: chain
echo "Test 10: chain"
CHAIN_RESULT=$(echo '[["url"],["js","document.title"]]' | $BROWSE --name smoke1 chain 2>/dev/null)
if echo "$CHAIN_RESULT" | grep -q '"ok":true'; then pass "chain"; else fail "chain"; fi

# Test 11: console + network buffers
echo "Test 11: console + network"
$BROWSE --name smoke1 console > /dev/null 2>&1
if [ $? -eq 0 ]; then pass "console command"; else fail "console command"; fi
$BROWSE --name smoke1 network > /dev/null 2>&1
if [ $? -eq 0 ]; then pass "network command"; else fail "network command"; fi

# Test 12: export-session
echo "Test 12: export-session"
SESSION_JSON=$($BROWSE --name smoke1 export-session 2>/dev/null)
if echo "$SESSION_JSON" | grep -q '"cookies"'; then pass "export-session"; else fail "export-session"; fi

# Cleanup
echo "Cleanup..."
$BROWSE --name smoke1 stop > /dev/null 2>&1 || true
$BROWSE --name smoke2 stop > /dev/null 2>&1 || true

echo ""
echo "Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
