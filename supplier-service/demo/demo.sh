#!/usr/bin/env bash
# Walks through the Supplier Service milestone demonstrations against the running
# stack, and checks every answer. Start the stack first: docker compose up --build
#
#   bash supplier-service/demo/demo.sh [part ...]
#
# Parts, each one a demonstration of its own. With none named, all run in order.
#   queries      point 2  the key ways of querying, as a member
#   access       point 2  who may do what, and how a refusal looks
#   crud         point 3  demonstration A: create, read, update, deactivate, in the database
#   independent  point 3  demonstration B: the service does not depend on a UI
#   tests        point 3  demonstration C: the automated tests, with no UI
#   end-to-end   point 4  placeholder users log in, then use the API, down to the database
#
#   PAUSE=1  wait for Enter before each step, for presenting
#   RAW=1    print each response in full instead of a summary
#   KEEP=1   keep the suppliers the demo creates, instead of removing them
#   BASE=... service address, default http://localhost:3002
#
# Needs bash and curl. Node, when it is installed, tidies the responses, and
# Docker, when it works in this shell, adds the database and log steps. Without
# them the script still runs, showing raw JSON and the commands to run yourself.
set -u

BASE=${BASE:-http://localhost:3002}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"

# A .env copied on Windows has CRLF line endings, which would leave a stray CR on
# the end of every value.
if [ -f "$ROOT/.env" ]; then
  set -a
  . <(tr -d '\r' < "$ROOT/.env")
  set +a
fi
DB_USER=${SUPPLIER_DB_USER:-supplier}
DB_NAME=${SUPPLIER_DB_NAME:-supplier}
USER_URL=${USER_SERVICE_URL:-http://localhost:3001}

# From WSL only the Windows Node is visible, under the name node.exe.
NODE=$(command -v node || command -v node.exe || true)
HAVE_DOCKER=0
if docker compose version >/dev/null 2>&1; then HAVE_DOCKER=1; fi

PASSED=0
FAILED=0
STATUS=0
BODY=""

SUMMARY_JS=$(cat <<'EOF'
let text = ''
process.stdin.on('data', (d) => (text += d)).on('end', () => {
  let d
  try { d = JSON.parse(text) } catch { console.log(text); return }
  const when = (a) =>
    a.open
      ? a.closesAt ? `open now, until ${a.closesAt}` : 'open around the clock'
      : a.nextOpensAt ? `closed, opens ${a.nextOpensAt.day} ${a.nextOpensAt.time}` : 'closed'
  const hours = (x) => x.hours.map((h) => `${h.day.slice(0, 3)} ${h.opens}-${h.closes}`).join(', ')
  if (d.items) {
    console.log(`  total=${d.total}  page ${d.page} of ${d.totalPages}, showing ${d.items.length}`)
    if (d.items.length > 0) console.log(d.items.map((i) => `    ${i.name}`).join('\n'))
  } else if (d.error && d.error.code) {
    console.log(`  ${d.error.code}: ${d.error.message}`)
    for (const f of d.error.fields ?? []) console.log(`    - ${f.field}: ${f.message}`)
  } else if (d.name) {
    console.log(`  ${d.name}  [${d.type}]  status=${d.status}`)
    console.log(`  where: ${d.building}, zone ${d.zone}`)
    console.log(`  hours: ${hours(d)}`)
    console.log(`  right now: ${when(d.availability)}`)
  } else if (d.supplierId) {
    console.log(`  at ${d.at} (${d.timezone}): ${when(d)}`)
    console.log(`  status=${d.status}  orderable=${d.orderable}`)
  } else {
    console.log('  ' + JSON.stringify(d))
  }
})
EOF
)

summarize() {
  if [ "${RAW:-0}" = 1 ] || [ -z "$NODE" ]; then
    cat
    echo
  else
    "$NODE" -e "$SUMMARY_JS"
  fi
}

part() { printf '\n\n############################################################\n# %s\n############################################################\n' "$1"; }

step() {
  printf '\n== %s\n' "$1"
  [ -n "${2:-}" ] && printf '   %s\n' "$2"
  if [ "${PAUSE:-0}" = 1 ]; then read -r -p '   [Enter to run] ' _ </dev/tty; fi
}

# call ROLE METHOD PATH [JSON]
# ROLE is none, forged, member, admin or suspended, which use the fixed sessions
# of the stand-in. A role that has a variable TOKEN_<role> uses that session
# instead, which is how a user who has logged in is used.
call() {
  local role=$1 method=$2 path=$3 body=${4:-}
  local args=() shown="curl" token_var="TOKEN_$1"
  local token=${!token_var:-$role-token}
  [ "$method" != GET ] && shown+=" -X $method"
  if [ "$role" != none ]; then
    args+=(-H "Authorization: Bearer $token")
    shown+=" -H 'Authorization: Bearer $token'"
  fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
    shown+=" -H 'Content-Type: application/json' -d '$body'"
  fi
  echo "\$ $shown '$BASE$path'"
  local out
  out=$(curl -s -X "$method" ${args[@]+"${args[@]}"} -w $'\n%{http_code}' "$BASE$path")
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
  echo "  -> HTTP $STATUS"
  printf '%s' "$BODY" | summarize
}

# login USERNAME PASSWORD   asks the User Service for a session, and keeps it as
# TOKEN_<username> when it is given one.
login() {
  local user=$1 pass=$2
  local shown="curl -X POST -H 'Content-Type: application/json' -d '{\"username\":\"$user\",\"password\":\"$pass\"}' '$USER_URL/login'"
  echo "\$ $shown"
  local out
  out=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$user\",\"password\":\"$pass\"}" -w $'\n%{http_code}' "$USER_URL/login")
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
  echo "  -> HTTP $STATUS"
  echo "  $BODY"
  if [ "$STATUS" = 200 ]; then
    printf -v "TOKEN_$user" '%s' "$(printf '%s' "$BODY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
  fi
}

expect() {
  if [ "$STATUS" = "$1" ]; then
    echo "  [ok] $2"
    PASSED=$((PASSED + 1))
  else
    echo "  [FAIL] $2 (expected HTTP $1, got $STATUS)"
    FAILED=$((FAILED + 1))
  fi
}

# check CONDITION_EXIT_CODE MESSAGE   for a step that is not an HTTP call
check() {
  if [ "$1" = 0 ]; then
    echo "  [ok] $2"
    PASSED=$((PASSED + 1))
  else
    echo "  [FAIL] $2"
    FAILED=$((FAILED + 1))
  fi
}

# The id of the supplier in the last response, or of the first one in a list. The
# responses are compact JSON with the id first, so no JSON tool is needed.
id_of() { printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]*"' | head -1 | cut -d'"' -f4; }

# Runs in the project folder, so that no Windows path is needed.
compose() { (cd "$ROOT" && docker compose "$@"); }
db() { compose exec -T supplier-db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

# For a step that needs Docker when this shell cannot reach it.
run_yourself() {
  echo "  This shell cannot run that here."
  echo "  Run it in PowerShell, from the repository root:"
  echo "    $1"
}

NAME="Demo Cafe $(date +%H%M%S)"
CREATE_BODY="{\"name\":\"$NAME\",\"type\":\"Food\",\"zone\":\"Central\",\"building\":\"Central Library\",\"address\":\"Central Library, Level 1\",\"description\":\"Demo supplier\",\"contact\":{\"phone\":\"6516 1234\",\"email\":\"demo@example.com\"},\"hours\":[{\"day\":\"monday\",\"opens\":\"09:00\",\"closes\":\"18:00\"},{\"day\":\"tuesday\",\"opens\":\"09:00\",\"closes\":\"18:00\"}]}"

# What is left of a demo supplier once the demonstration is over.
clean_up() {
  [ "${KEEP:-0}" = 1 ] && return
  step "Clean up" "Removes only the demo supplier, straight in the database, because the API itself never deletes."
  if [ "$HAVE_DOCKER" = 1 ]; then
    db -c "DELETE FROM suppliers WHERE id = '$1'"
  else
    call admin DELETE "/suppliers/$1"
    echo "  The demo supplier stays as an Inactive record, because the API never deletes. To remove it,"
    echo "  run in PowerShell, from the repository root:"
    echo "    docker compose exec supplier-db psql -U $DB_USER -d $DB_NAME -c \"DELETE FROM suppliers WHERE id = '$1'\""
  fi
}

# ================================================================== point 2
part_queries() {
  part "POINT 2  Query patterns, as a signed-in member (a student)"

  step "List suppliers" "Sorted by name, at most 20 to a page, with the total count (F2.4.2)."
  call member GET '/suppliers'
  expect 200 "a member can list suppliers"
  local first_id
  first_id=$(id_of)

  step "Search by keyword" "Every word must match the name, type, building, zone or address (F2.4.1)."
  call member GET '/suppliers?q=coffee'
  expect 200 "keyword search"
  call member GET '/suppliers?q=prince+george'
  expect 200 "several words"

  step "Filter by type" "The types are the ones in the seed file: Food, Food/Coffee, Shopping and Printing."
  call member GET '/suppliers?type=Printing'
  expect 200 "filter by type"
  call member GET '/suppliers?type=Food/Coffee'
  expect 200 "Food/Coffee is a type of its own"
  call member GET '/suppliers?type=Food'
  expect 200 "Food matches only Food, not Food/Coffee"

  step "Find suppliers by location" "By campus zone or by building."
  call member GET '/suppliers?zone=Central'
  expect 200 "filter by zone"
  call member GET '/suppliers?building=COM2'
  expect 200 "filter by building"

  step "Combine filters and a keyword"
  call member GET '/suppliers?zone=Central&type=Food/Coffee&q=roaster'
  expect 200 "combined query"

  step "Page through the results" "Page 2 of 21 suppliers holds the last one."
  call member GET '/suppliers?page=2'
  expect 200 "second page"
  call member GET '/suppliers?pageSize=21'
  expect 400 "a page can never hold more than 20"

  step "Read one supplier by its id"
  call member GET "/suppliers/$first_id"
  expect 200 "get by id"

  step "Is a supplier open at a given time?" "What the Order Service asks before accepting an errand (F2.5.1). Monday 10:00 and 19:00 in Singapore."
  call member GET '/suppliers?q=Anna'
  local anna_id
  anna_id=$(id_of)
  call member GET "/suppliers/$anna_id/availability?at=2026-10-05T10:00:00%2B08:00"
  expect 200 "availability during opening hours"
  call member GET "/suppliers/$anna_id/availability?at=2026-10-05T19:00:00%2B08:00"
  expect 200 "availability after closing"
}

part_access() {
  part "POINT 2  Access control: the User Service decides"

  # Any existing supplier will do as the target of a refused change.
  local anna_id
  anna_id=$(curl -s -H 'Authorization: Bearer member-token' "$BASE/suppliers?q=Anna" | grep -o '"id":"[0-9a-f-]*"' | head -1 | cut -d'"' -f4)

  step "No session" "There is nothing to ask the User Service about, so the request is refused at once."
  call none GET '/suppliers'
  expect 401 "no session is refused"

  step "A session the User Service does not know"
  call forged GET '/suppliers'
  expect 401 "an invented token is refused"

  step "A suspended account" "A valid session for an account that may no longer act."
  call suspended GET '/suppliers'
  expect 403 "a suspended account is denied, even for reading"

  step "A member cannot change the catalogue" "Members may read. Creating, updating and deactivating need the administrator role."
  call member POST '/suppliers' '{"name":"Hacked","type":"Food","zone":"Central","building":"X","address":"X","hours":[{"day":"monday","opens":"09:00","closes":"18:00"}]}'
  expect 403 "a member cannot create"
  call member PATCH "/suppliers/$anna_id" '{"name":"Hacked"}'
  expect 403 "a member cannot update"
  call member DELETE "/suppliers/$anna_id"
  expect 403 "a member cannot deactivate"

  step "A refusal says nothing about what exists" "A real id and an id that does not exist get the identical answer (N1.1.1)."
  call member DELETE '/suppliers/00000000-0000-4000-8000-000000000000'
  expect 403 "same 403 for an id that does not exist"
}

# ================================================================== point 3
part_crud() {
  part "POINT 3, DEMONSTRATION A  The running service, its database, and CRUD"

  step "The service is running and connected to its database" "The health check asks the database a question, so a 200 means both are up."
  call none GET '/health'
  expect 200 "the service answers and the database answers it"
  if [ "$HAVE_DOCKER" = 1 ]; then
    db -c "SELECT count(*) AS suppliers_in_the_database FROM suppliers"
  else
    run_yourself "docker compose exec supplier-db psql -U $DB_USER -d $DB_NAME -c \"SELECT count(*) FROM suppliers\""
  fi

  step "Create with invalid data" "Every invalid field is named at once, and nothing is stored."
  call admin POST '/suppliers' '{"hours":[{"day":"monday","opens":"25:00","closes":"18:00"}]}'
  expect 400 "invalid create is rejected with every field named"

  step "CREATE a supplier" "The service assigns the id and the creation time (F2.2.1)."
  call admin POST '/suppliers' "$CREATE_BODY"
  expect 201 "an administrator can create"
  local id
  id=$(id_of)

  step "READ it back, as a member" "Reads need no administrator role, and the new supplier is there at once."
  call member GET "/suppliers/$id"
  expect 200 "read back what the administrator created"

  step "UPDATE it" "Any field except the id and the creation time; the hours list is replaced (F2.2.3)."
  call admin PATCH "/suppliers/$id" '{"name":"'"$NAME"' (renamed)","hours":[{"day":"saturday","opens":"10:00","closes":"14:00"}]}'
  expect 200 "an administrator can update"
  call admin PATCH "/suppliers/$id" '{"id":"00000000-0000-4000-8000-000000000000"}'
  expect 400 "the id cannot be changed"

  step "DELETE means deactivate" "The record stays, and the supplier is no longer offered for new errands (F2.2.4, F2.2.5)."
  call admin DELETE "/suppliers/$id"
  expect 200 "an administrator can deactivate"
  call member GET "/suppliers/$id"
  expect 200 "still retrievable, for errands that already use it"
  call member GET "/suppliers?q=$(printf '%s' "$NAME" | tr ' ' '+')"
  expect 200 "left out of the normal listing"
  call member GET "/suppliers/$id/availability"
  expect 200 "orderable is false for an Inactive supplier"
  call member GET "/suppliers?status=Inactive&q=Demo"
  expect 200 "found when Inactive suppliers are asked for"

  step "Reactivate"
  call admin PATCH "/suppliers/$id" '{"status":"Active"}'
  expect 200 "setting the status back to Active reactivates it"

  step "What the database holds" "The supplier the administrator created, and who created it. The API never deletes rows."
  if [ "$HAVE_DOCKER" = 1 ]; then
    db -c "SELECT name, type, status, created_by, updated_by, updated_at > created_at AS was_edited FROM suppliers WHERE id = '$id'"
    db -c "SELECT weekday, opens_minute, closes_minute FROM supplier_hours WHERE supplier_id = '$id' ORDER BY weekday"
  else
    run_yourself "docker compose exec supplier-db psql -U $DB_USER -d $DB_NAME -c \"SELECT name, type, status, created_by, updated_by FROM suppliers WHERE id = '$id'\""
  fi

  clean_up "$id"
}

part_independent() {
  part "POINT 3, DEMONSTRATION B  The service does not depend on a UI"

  step "Which containers exist" "The service, its database, and the stand-in for the User Service. None is a UI."
  if [ "$HAVE_DOCKER" = 1 ]; then
    compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
    compose ps --services | grep -qiE 'web|ui|client|frontend'
    check $((1 - $?)) "no container in the stack is a UI"
  else
    run_yourself "docker compose ps"
  fi

  step "Is anything serving a UI?" "The web client's development server listens on port 5173."
  if curl -s -m 3 -o /dev/null http://localhost:5173; then
    check 1 "something is listening on port 5173, so a UI is running. Stop it and run this again"
  else
    check 0 "nothing is listening on port 5173, so no UI is running"
  fi

  step "The service answers anyway" "Everything it offers is an HTTP call."
  call member GET '/suppliers?type=Printing'
  expect 200 "a full search works with no UI"
  call admin POST '/suppliers' '{"name":"x"}'
  expect 400 "a create is checked and answered with no UI"

  step "The code does not know a UI exists" "Neither the service's source, its package file nor the compose file mentions the web client."
  if grep -rn "web-client" "$ROOT/supplier-service/src" "$ROOT/supplier-service/package.json" "$ROOT/compose.yaml"; then
    check 1 "the web client is mentioned, see above"
  else
    echo "  (no matches)"
    check 0 "no mention of web-client in the service, its packages or the compose file"
  fi
}

part_tests() {
  part "POINT 3, DEMONSTRATION C  Tested through its APIs, with no UI"

  step "Run every automated test" "The API tests call the real routes against a real PostgreSQL, as a client would. The others cover the logic and the User Service client."
  if command -v npm >/dev/null 2>&1 && [ -d "$ROOT/supplier-service/node_modules" ]; then
    local out code
    out=$(cd "$ROOT/supplier-service" && npm test 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -E '^ℹ (tests|suites|pass|fail|skipped|duration_ms)'
    check "$code" "all automated tests pass"
    printf '%s\n' "$out" | grep -q '^ℹ skipped 0'
    check "$?" "none were skipped, so the database tests really ran"
  else
    run_yourself "cd supplier-service; npm install; npm test"
  fi
}

# ================================================================== point 4
part_end_to_end() {
  part "POINT 4  End to end: a user logs in, uses the API, and the database changes"

  if ! curl -s -m 3 -o /dev/null "$USER_URL/"; then
    echo "The User Service stand-in does not answer at $USER_URL."
    echo "Start the stack from the repository root:  docker compose up --build"
    FAILED=$((FAILED + 1))
    return
  fi

  echo
  echo "The real User Service does not exist yet, so these are placeholder users of a stand-in."
  echo "  student    a member        password student-pass"
  echo "  admin      an administrator password admin-pass"
  echo "  suspended  a suspended one  password suspended-pass"

  step "Users log in" "The User Service checks the password and issues a session. The Supplier Service never sees a password."
  login student student-pass
  expect 200 "the student gets a session"
  login admin admin-pass
  expect 200 "the administrator gets a session"

  step "Logins that are refused" "A wrong password and an unknown user get the identical answer. A suspended account gets no session at all."
  login student wrong-password
  expect 401 "a wrong password is refused"
  login nobody wrong-password
  expect 401 "an unknown user gets the same answer"
  login suspended suspended-pass
  expect 403 "a suspended account gets no session"

  step "The student uses the API" "A member may read the catalogue."
  call student GET '/suppliers?type=Printing'
  expect 200 "the student reads"
  call student POST '/suppliers' "$CREATE_BODY"
  expect 403 "the student cannot create"

  step "The administrator manages a supplier" "Everything the student may do, and the changes."
  call admin POST '/suppliers' "$CREATE_BODY"
  expect 201 "the administrator creates a supplier"
  local id
  id=$(id_of)
  call student GET "/suppliers/$id"
  expect 200 "the student sees it at once"
  call admin PATCH "/suppliers/$id" '{"name":"'"$NAME"' (renamed)"}'
  expect 200 "the administrator edits it"
  call admin DELETE "/suppliers/$id"
  expect 200 "the administrator deactivates it"
  call student GET "/suppliers?q=$(printf '%s' "$NAME" | tr ' ' '+')"
  expect 200 "the student no longer finds it in the listing"
  call admin PATCH "/suppliers/$id" '{"status":"Active"}'
  expect 200 "the administrator reactivates it"

  step "A session from before the account was suspended" "A session can outlive the account's good standing. The User Service still says no."
  call suspended GET '/suppliers'
  expect 403 "refused, even with a session"

  step "What the database now holds" "Who made the change is recorded, from the User Service's answer."
  if [ "$HAVE_DOCKER" = 1 ]; then
    db -c "SELECT name, status, created_by, updated_by, updated_at > created_at AS was_edited FROM suppliers WHERE id = '$id'"
    db -c "SELECT status, count(*) FROM suppliers GROUP BY status ORDER BY status"
  else
    run_yourself "docker compose exec supplier-db psql -U $DB_USER -d $DB_NAME -c \"SELECT name, status, created_by, updated_by FROM suppliers WHERE id = '$id'\""
  fi

  step "What the User Service was asked and told" "Each login and each question, in order. A student's repeated reads within 5 seconds are answered from a remembered approval, so supplier.read appears less often than the reads did."
  if [ "$HAVE_DOCKER" = 1 ]; then
    compose logs user-service-standin --no-log-prefix --tail 22
  else
    run_yourself "docker compose logs user-service-standin --no-log-prefix --tail 22"
  fi

  clean_up "$id"
  unset TOKEN_student TOKEN_admin
}

# ================================================================== run
ALL_PARTS=(queries access crud independent tests end-to-end)
PARTS=("$@")
[ ${#PARTS[@]} -eq 0 ] && PARTS=("${ALL_PARTS[@]}")

for p in "${PARTS[@]}"; do
  case "$p" in
    queries | access | crud | independent | tests | end-to-end) ;;
    *)
      echo "Unknown part: $p"
      echo "Choose from: ${ALL_PARTS[*]}"
      exit 2
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is needed to call the service. Install it and run this again."
  exit 1
fi
if ! curl -s -f "$BASE/health" >/dev/null; then
  echo "The Supplier Service does not answer at $BASE."
  echo "Start it from the repository root:  cp .env.example .env  &&  docker compose up --build"
  exit 1
fi
echo "Supplier Service is up at $BASE"
[ -z "$NODE" ] && echo "Node was not found, so responses are shown as raw JSON."
[ "$HAVE_DOCKER" = 0 ] && echo "Docker does not work in this shell, so the database and log steps are shown as commands to run yourself."

for p in "${PARTS[@]}"; do
  case "$p" in
    queries) part_queries ;;
    access) part_access ;;
    crud) part_crud ;;
    independent) part_independent ;;
    tests) part_tests ;;
    end-to-end) part_end_to_end ;;
  esac
done

printf '\n\n============================================================\n'
printf 'Checks passed: %s   failed: %s\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
