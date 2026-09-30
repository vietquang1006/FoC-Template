# Supplier Service milestone: answers and demonstration scripts

Points 1 and 2 are answered question by question. Point 3 has a script for each of
its three demonstrations. Point 4 starts with a straight answer about what exists
and what does not, and then has its own script. Point 5, the UI, is not covered.
The full reference for every claim is in `README.md`.

Every demonstration runs from one command, so what you say matches what the
audience sees.

## Before you start

From the repository root, with Docker Desktop running:

```bash
cp .env.example .env            # once
docker compose up --build       # about 15 seconds after the first time
```

Each demonstration is a part of one script. Run a part on its own, or run them all:

```bash
bash supplier-service/demo/demo.sh queries       # point 2, the ways of querying
bash supplier-service/demo/demo.sh access        # point 2, who may do what
bash supplier-service/demo/demo.sh crud          # point 3, demonstration A
bash supplier-service/demo/demo.sh independent   # point 3, demonstration B
bash supplier-service/demo/demo.sh tests         # point 3, demonstration C
bash supplier-service/demo/demo.sh end-to-end    # point 4
bash supplier-service/demo/demo.sh               # all six, 54 checks
```

Put `PAUSE=1` in front to wait for Enter before each step, which is how to present.
The script prints the exact `curl` command of every call and checks every answer,
so a part that ends with `failed: 0` is safe to show. Before presenting, run the
whole thing once. To reset the data: `docker compose down -v` and start again.

The script needs only bash and `curl`. What else it finds in your shell adds to
the output:

| Your shell | What you get |
| --- | --- |
| Git Bash | Everything: formatted responses, the database steps and the User Service log |
| WSL, Docker not connected | Every call and its check. The database and log steps print the PowerShell command to run instead, and the demo supplier is deactivated at the end and not removed |
| WSL, with Docker Desktop's WSL integration turned on | The same as Git Bash |
| No Node in the shell | Responses are shown as raw JSON, and everything else works |

WSL sees the Windows Node only as `node.exe`, and the script looks for that too.

---

# Point 1: Database choice and schema design

## Which database technology have you selected?

**PostgreSQL 17**, a relational database. It is the Supplier Service's own
database and nothing else reads it. The Order Service will ask the API.

## Why, for FoC in particular?

**The nature of the data.** A supplier has a fixed list of fields, and the backlog
names all of them (F2.1.1). No supplier needs a field another does not have, so
the flexibility of a document database would go unused. The one part that could
look flexible, the weekly opening hours, is a repeating group of at most 7 rows
per supplier, and a child table models that exactly.

**The expected query patterns.** Keyword search, filtering by type and location,
sorting by name, and paging with a total count (F2.4) are `WHERE`, `ILIKE`,
`ORDER BY`, `LIMIT` and a count. That is what SQL does natively, and indexes
speed it up. One query returns a page and its total.

**Integrity.** F2.2.1 asks for "complete and valid" fields. The database refuses
a bad row by itself, whatever the service does: a status can only be Active or
Inactive, a supplier cannot open and close at the same minute, coordinates come
as a pair, and every text field has a length limit. There are 13 check
constraints in all.

**Safe writes.** Creating or updating a supplier and its hours is one
transaction. Two administrators editing the same supplier are applied one after
the other, because the update locks the row.

**Scalability.** The catalogue is small, tens to hundreds of suppliers, mostly
read, and changed only by administrators. The 100 ms target with 1000 clients
(N2) is met by one indexed query plus a short cache, in front of a service that
keeps no state and so can run as many copies as needed. We measured a 99th
percentile of 2.8 ms with 1000 concurrent clients. If reads ever outgrow one
database, PostgreSQL has read replicas.

**Why not the alternatives.** A document database such as MongoDB fits records
that differ from each other, and these do not, so we would give up
database-enforced rules for flexibility we do not use. A key-value store such as
Redis cannot do the search, filter and sort that F2.4 asks for. SQLite is a file
inside one container, so several copies of the service could not share it.

## The concrete schema

Two tables and one relationship.

```text
suppliers (1) ----< supplier_hours (0 to 7)      one row per weekday it is open
```

| Table | Field | Type | Notes |
| --- | --- | --- | --- |
| `suppliers` | `id` | uuid | Primary key, made by the database |
| | `name` | text | 1 to 120 characters |
| | `type` | text | 1 to 60 characters, as in the seed file: Food, Food/Coffee, Shopping, Printing |
| | `zone` | text | Campus zone, such as Central or Computing |
| | `building` | text | Used to find by place |
| | `address` | text | The line shown to users |
| | `description` | text | Optional, how to find it |
| | `latitude`, `longitude` | double | Optional, set as a pair |
| | `phone`, `email` | text | Optional contact details |
| | `status` | enum | Active or Inactive, default Active |
| | `created_at`, `updated_at` | timestamptz | Set by the database |
| | `created_by`, `updated_by` | text | Account id of the administrator, from the User Service |
| `supplier_hours` | `supplier_id` | uuid | Foreign key to `suppliers`, primary key with `weekday` |
| | `weekday` | smallint | 0 to 6, Monday is 0 |
| | `opens_minute` | smallint | 0 to 1439, minutes after local midnight |
| | `closes_minute` | smallint | 1 to 1440, where 1440 is midnight at the end of the day |

A weekday with no row is closed all day. Times are stored as minutes so that
`24:00` is exact, and a `closes_minute` below `opens_minute` means the window runs
past midnight, so 11:00 to 02:00 is opens 660, closes 120.

## The metadata of a supplier, and how it is stored and queried

| Metadata | Stored in | Queried by |
| --- | --- | --- |
| Name | `suppliers.name` | keyword search, and the sort order of every list |
| Type | `suppliers.type`, free text taken from the seed file | filter `type`, keyword search |
| Location | `zone`, `building`, `address`, and the coordinates | filters `zone` and `building`, keyword search |
| Opening hours | rows in `supplier_hours` | worked out into open or closed on each request |
| Status | `suppliers.status` | filter `status`, Active by default |
| Who and when | `created_at`, `updated_at`, `created_by`, `updated_by` | not returned by the API, kept as an audit trail |

The type is free text on purpose. It starts as exactly what the seed file writes,
and an administrator may add a new one. `Food/Coffee` is a type of its own, so
filtering by `Food` does not include it.

Whether a supplier is open is not stored. It is worked out from the hours when a
request arrives, on the campus clock (Asia/Singapore), including hours that run
past midnight.

## How to show point 1

The real tables, with their constraints and indexes, and real rows:

```bash
docker compose exec supplier-db psql -U supplier -d supplier -c "\d suppliers"
docker compose exec supplier-db psql -U supplier -d supplier -c "\d supplier_hours"
docker compose exec supplier-db psql -U supplier -d supplier -c "SELECT name, type, zone, building, status FROM suppliers ORDER BY lower(name) LIMIT 5"
docker compose exec supplier-db psql -U supplier -d supplier -c "SELECT type, count(*) FROM suppliers GROUP BY type ORDER BY count(*) DESC"
docker compose exec supplier-db psql -U supplier -d supplier -c "SELECT s.name, h.weekday, h.opens_minute, h.closes_minute FROM suppliers s JOIN supplier_hours h ON h.supplier_id = s.id WHERE s.name = 'Supersnacks' ORDER BY h.weekday LIMIT 3"
```

Point out that the types are exactly the four in the seed file, and that
Supersnacks closes at minute 120, below its opening minute 660, which is how a
closing time after midnight is stored. To show the database refusing bad data by
itself, this fails with a check violation and changes nothing:

```bash
docker compose exec supplier-db psql -U supplier -d supplier -c "INSERT INTO supplier_hours VALUES ((SELECT id FROM suppliers LIMIT 1), 1, 600, 600)"
```

---

# Point 2: Query patterns and API design

## What are the key ways the service is queried?

| The service is asked for | Request |
| --- | --- |
| One supplier by id | `GET /suppliers/{id}` |
| Everything, a page at a time | `GET /suppliers?page=2` |
| A keyword | `GET /suppliers?q=coffee` |
| Suppliers of a type | `GET /suppliers?type=Printing`, `?type=Food/Coffee` |
| Suppliers by location | `GET /suppliers?zone=Central`, `?building=COM2` |
| Any combination | `GET /suppliers?zone=Central&type=Food/Coffee&q=roaster` |
| Deactivated suppliers | `GET /suppliers?status=Inactive` or `?status=all` |
| Is it open at this time, and may an errand use it | `GET /suppliers/{id}/availability?at=...` |

Results are always sorted by name and come at most 20 to a page, with the total
count (F2.4.2). Every supplier in a response says whether it is open right now.

## Which endpoints expose these, and do they work?

| Endpoint | Who may call it |
| --- | --- |
| `GET /suppliers`, `GET /suppliers/{id}`, `GET /suppliers/{id}/availability` | any signed-in member |
| `POST /suppliers` | administrator |
| `PATCH /suppliers/{id}` | administrator |
| `DELETE /suppliers/{id}` (deactivates) | administrator |
| `GET /health` | anyone |

Show every query pattern with real calls:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh queries
```

It runs 14 checks: the list, a keyword, a type, `Food/Coffee`, `Food`, a zone, a
building, a combination, page 2, a page size that is too big, one supplier by id,
and availability before and after closing time.

## How do the endpoints use identity and role information from the User Service?

The Supplier Service never looks inside a session and never decides who is an
administrator. The User Service is the single authority (N1.1). For every request
the Supplier Service passes the caller's `Authorization` header on unchanged and
names the operation:

```text
client --- request + Authorization: Bearer <session> ---> Supplier Service
Supplier Service --- POST /authorize {"operation":"supplier.create"} ---> User Service
User Service --- 200 {"accountId": "..."}  or  401  or  403 ---> Supplier Service
Supplier Service --- only after a 200: run the query ---> database
```

The four operations are `supplier.read`, `supplier.create`, `supplier.update` and
`supplier.deactivate`. The User Service decides which roles may do which, so the
rule "administrators manage suppliers, members read" (F1.5.4) lives in one place.
The account id in the answer is stored as `created_by` and `updated_by`.

## How are denied requests answered?

| Who | Read | Create, update, deactivate |
| --- | --- | --- |
| No session, or one nobody issued | 401 | 401 |
| A suspended account | 403 | 403 |
| Member | allowed | 403 |
| Administrator | allowed | allowed |
| The User Service does not answer | 503 | 503 |

```json
{ "error": { "code": "FORBIDDEN", "message": "You are not allowed to do this" } }
```

- **401 or 403.** 401 means there is no valid session. 403 means the session is
  valid but the account may not do this, which includes a suspended account.
- **Checked first.** The check runs before the body is read or the database is
  touched, so a refusal changes nothing (F1.5.3).
- **A refusal reveals nothing.** A member who tries to change a supplier that
  exists, one that does not, and text that is not an id gets the identical 403
  (N1.1.1).
- **Fails closed.** If the User Service is down or unreadable, the answer is 503
  and nothing is served.

Show it:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh access
```

It runs 7 checks: no session, a made-up token, a suspended account, a member
trying to create, update and deactivate, and the identical 403 for an id that
does not exist.

---

# Point 3: Demonstration scripts

Each script is a table of the runner's steps. **Say** is what to tell the
audience, **Run** is what to do, and **You will see** is what appears on screen.

## Demonstration A: a running service connected to a database, with working CRUD

About 4 minutes. Run:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh crud
```

| Step | Say | You will see |
| --- | --- | --- |
| The service is running and connected | "The health check asks the database a question, so a 200 means the service and its database are both up. This count comes straight from the database." | `HTTP 200`, then `suppliers_in_the_database: 21` |
| Create with invalid data | "First a bad request. The service names every invalid field at once, and nothing is stored." | `HTTP 400` and a list of fields: type, zone, building, address, name and the bad opening time |
| CREATE | "Now a valid one, as an administrator. The service assigns the id and the creation time itself." | `HTTP 201` and the new supplier with its hours |
| READ it back, as a member | "A member reads it straight away. Reading needs no administrator role." | `HTTP 200` and the same supplier |
| UPDATE it | "The administrator renames it and replaces its hours. The id cannot be changed, and the service says so." | `HTTP 200` with the new name and hours, then `HTTP 400: id: cannot be set` |
| DELETE means deactivate | "Delete only sets the supplier to Inactive, as the backlog says. It is still retrievable for errands that already use it, but it leaves the normal list and is no longer orderable." | `status=Inactive`, then `HTTP 200` by id, `total=0` in the list, `orderable=false`, and found with `status=Inactive` |
| Reactivate | "Setting the status back to Active undoes it." | `HTTP 200`, `status=Active` |
| What the database holds | "This is the row in PostgreSQL, and who created it, from the User Service's answer. The weekday row is the Saturday hours we set." | A row with `created_by = admin-account-1`, `was_edited = t`, and one hours row, `5 | 600 | 840` |
| Clean up | "The API never deletes, so the demo removes only its own supplier, straight in the database." | `DELETE 1` |

**Closing line:** "Create, read, update and deactivate all work through the API, and every
change is in the database."

## Demonstration B: the service is independent, and does not depend on a UI

About 2 minutes. Make sure no web client is running. Run:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh independent
```

| Step | Say | You will see |
| --- | --- | --- |
| Which containers exist | "The whole stack is three containers: the service, its database, and a stand-in for the User Service. None of them is a UI." | A table of `supplier-db`, `supplier-service`, `user-service-standin`, all running, and `[ok] no container in the stack is a UI` |
| Is anything serving a UI? | "The web client's development server would listen on port 5173. Nothing is there." | `[ok] nothing is listening on port 5173, so no UI is running` |
| The service answers anyway | "A full search and a create are both answered, checked and validated with no UI anywhere." | `HTTP 200` with the two printing suppliers, then `HTTP 400` naming the missing fields |
| The code does not know a UI exists | "The service's source, its package file and the compose file never mention the web client." | `(no matches)` and `[ok] no mention of web-client in the service, its packages or the compose file` |

**Closing line:** "Everything the service does is an HTTP call, and nothing in it knows a UI
exists."

## Demonstration C: used and tested through its APIs, with no UI present

About 2 minutes. This needs `docker compose up -d supplier-db` and `npm install` in
`supplier-service` once. Run:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh tests
```

| Step | Say | You will see |
| --- | --- | --- |
| Run every automated test | "These 156 tests call the real routes against a real PostgreSQL, the way a client would. 48 of them are API tests. The rest cover the validation, the opening-hours logic, the caches and the User Service client." | `tests 156`, `pass 156`, `fail 0`, `skipped 0`, then two `[ok]` lines |

Then say what "none were skipped" means: the database tests are skipped when there
is no database, so a run with none skipped proves the SQL ran. If you want one
more proof that a UI is not involved:

```bash
grep -rn "web-client" supplier-service/test supplier-service/src
```

It prints nothing. One group of tests, in `test/app.test.ts`, hands the service a
database that fails the test if it is asked anything. It proves that a refused,
invalid or unauthenticated request never reaches the database.

**Closing line:** "The service is tested entirely through its API and its database, and no
UI is involved anywhere."

---

# Point 4: End-to-end integration

## Do we have it yet?

Partly, and it is important to say which part.

| | Do we have it? |
| --- | --- |
| The Supplier Service acting on a user's identity and role | **Yes.** It asks the User Service on every request, enforces the roles, refuses correctly, and records who made each change |
| The real User Service, with real accounts and a real login | **No.** The `user-service` folder is empty, and no language, framework or database has been chosen for it. That service is someone else's |
| Placeholder users with different roles | **Yes, added.** The stand-in User Service now has three named users who log in with a password and get a session |
| A complete flow from a logged-in user to the database | **Yes, with the placeholder users.** It is a real flow through the real Supplier Service and the real database. Only the accounts are placeholders |

So point 4 can be shown, as long as it says plainly that the users are
placeholders. When the real User Service exists, only its address in `.env` changes,
plus `src/auth.ts` if its contract differs, and the script is run again with real
accounts.

## The placeholder users

They live in `dev/fake-user-service.ts`, which is never part of the service's
container image.

| Username | Password | Role | Can log in? |
| --- | --- | --- | --- |
| `student` | `student-pass` | member | yes |
| `admin` | `admin-pass` | administrator, and member | yes |
| `suspended` | `suspended-pass` | member, but the account is suspended | no, the login is refused |

A login returns a session. The client then sends that session to the Supplier
Service, which asks the User Service whether it may do what it is asking.

```text
user --- username + password ---> User Service              (the Supplier Service never sees a password)
user <--- session --------------- User Service
user --- request + session -----> Supplier Service
Supplier Service --- "may this session do supplier.create?" ---> User Service
Supplier Service --- if yes: query --------------------------> database
user <--- the result -----------  Supplier Service
```

## Demonstration: from a logged-in user to the database, for each role

About 4 minutes. Run:

```bash
PAUSE=1 bash supplier-service/demo/demo.sh end-to-end
```

| Step | Say | You will see |
| --- | --- | --- |
| Users log in | "The real User Service does not exist yet, so these are placeholder users of a stand-in. The User Service checks the password and issues a session. The Supplier Service never sees a password." | Two `HTTP 200` answers, each with a `session-...` token, an account id and the roles |
| Logins that are refused | "A wrong password and an unknown user get the identical answer, so nobody can find out which usernames exist. A suspended account gets no session at all." | `HTTP 401 Invalid username or password` twice, identical, then `HTTP 403 This account is not active` |
| The student uses the API | "The student's session may read the catalogue, and is refused when it tries to create." | `HTTP 200` with the two printing suppliers, then `HTTP 403 FORBIDDEN` |
| The administrator manages a supplier | "The administrator creates a supplier, and the student sees it at once. The administrator edits it, deactivates it, and the student no longer finds it in the list. Then it is reactivated. This is the whole supplier-management experience." | `201`, then `200` for the student, `200` for the edit, `status=Inactive`, `total=0` for the student, and `status=Active` again |
| A session from before the account was suspended | "A session can outlive the account's good standing. The User Service still says no, so the Supplier Service refuses." | `HTTP 403 FORBIDDEN` |
| What the database now holds | "This is the row the administrator created, in PostgreSQL. Who created it and who last changed it come from the User Service's answer." | `created_by` and `updated_by` both `admin-account-1`, `was_edited = t`, and a count of Active and Inactive suppliers |
| What the User Service was asked and told | "Every login and every question, in order. The student's session and the administrator's are named, and only the last six characters of each token appear." | Lines such as `login student -> 200`, `authorize supplier.create for student (2f14b0) -> 403`, `authorize supplier.create for admin (f49c7a) -> 200` |
| Clean up | "The demo removes only its own supplier." | `DELETE 1` |

A student's repeated reads within 5 seconds are answered from a remembered
approval, so `supplier.read` appears in the log less often than the reads did.
Every write and every refusal is asked each time.

**Closing line:** "A user logs in, the Supplier Service asks the User Service what that user
may do, and the database changes only for the person allowed to change it. The
accounts are placeholders until the real User Service exists."

---

# Showing it on screen

There is no UI yet, so the audience needs another way to see results. Split one
screen into three panes, so that every call shows up in three places at once:

| Pane | What the audience sees | Command, from the repository root |
| --- | --- | --- |
| A, left, large | The calls and their answers | `PAUSE=1 bash supplier-service/demo/demo.sh crud` |
| B, top right | Each login and each question the Supplier Service asks the User Service | `docker compose logs -f --tail 0 user-service-standin` |
| C, bottom right | The database, refreshed every second | the loop below |

In Windows Terminal, `Alt+Shift+Plus` splits a pane to the right,
`Alt+Shift+Minus` splits it downward, `Alt+Arrow` moves between panes, and
`Ctrl+Plus` makes the text bigger for the room. Run the `docker` commands in
PowerShell. Pane C, in PowerShell:

```powershell
while ($true) { Clear-Host; docker compose exec -T supplier-db psql -U supplier -d supplier -c "SELECT to_char(updated_at,'HH24:MI:SS') AS changed, name, type, status, created_by AS by FROM suppliers ORDER BY updated_at DESC, name LIMIT 6" -c "SELECT status, count(*) AS suppliers FROM suppliers GROUP BY status ORDER BY status"; Start-Sleep 1 }
```

The same for Git Bash, which needs Docker on its path first:

```bash
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
while true; do clear; docker compose exec -T supplier-db psql -U supplier -d supplier -c "SELECT to_char(updated_at,'HH24:MI:SS') AS changed, name, type, status, created_by AS by FROM suppliers ORDER BY updated_at DESC, name LIMIT 6" -c "SELECT status, count(*) AS suppliers FROM suppliers GROUP BY status ORDER BY status"; sleep 1; done
```

Pane C lists the six most recently changed suppliers, newest first, and the count
of Active and Inactive suppliers. A supplier changed through the API jumps to the
top with the time of the change and the administrator's account id, so the
audience sees the database react.

## What appears, step by step

This is what the three panes showed when we rehearsed it with the fixed sessions.
With `end-to-end`, pane B names the logged-in user, as in `for admin (f49c7a)`.

| Step | Pane A: the call | Pane B: the User Service log | Pane C: the database |
| --- | --- | --- | --- |
| A member lists suppliers | HTTP 200 and the names | `authorize supplier.read for member-token -> 200` | Nothing changes |
| A member tries to create one | HTTP 403 | `authorize supplier.create for member-token -> 403` | Nothing changes, still 21 Active |
| An administrator creates one | HTTP 201 and the supplier | `authorize supplier.create for admin-token -> 200` | A new row at the top with `by = admin-account-1`, Active count 22 |
| The administrator renames it | HTTP 200 | `authorize supplier.update for admin-token -> 200` | The row's time and name change |
| The administrator deactivates it | HTTP 200, status Inactive | `authorize supplier.deactivate for admin-token -> 200` | Its status turns Inactive, counts read 21 Active and 1 Inactive |
| The administrator reactivates it | HTTP 200, status Active | `authorize supplier.update for admin-token -> 200` | Its status turns Active again, count 22 |

The best single moment to point at is the creation step: the 201 on the left,
the User Service's 200 at the top right, and the new row with the
administrator's id at the bottom right, all from one request.

Two things to say if asked. A member's repeated reads within 5 seconds are
answered from a remembered approval, so they do not add lines to pane B. And
pane C reads the database directly, so it shows what is really stored, not what
the API reports.

## Keep a record for the report

To save everything the script printed:

```bash
bash supplier-service/demo/demo.sh | tee demo-output.txt
```

A screenshot of the three panes right after the creation step is the strongest
single image for the report.

## If a pane cannot be used

- **Pane B.** Docker Desktop shows the same log: Containers, then
  `user-service-standin`, then Logs.
- **Pane C.** Any database tool can replace it. Connect to `localhost` port
  `5433`, database `supplier`, user `supplier`, with the password from your
  `.env`, and refresh after each step.
- **The best fix is the UI.** Once point 5 exists, pane A becomes the browser and
  the audience sees suppliers appear on a real page while panes B and C show
  what happened behind it.

---

# If something goes wrong

| Symptom | Fix |
| --- | --- |
| `$'\r': command not found` or `set: -: invalid option` | The script has Windows line endings, which bash cannot read. Fix the file with `sed -i 's/\r$//' supplier-service/demo/demo.sh`. The repository's `.gitattributes` keeps `.sh` files on Unix line endings in future checkouts |
| The script says the service does not answer | `docker compose up --build`, then `docker compose ps` should show `healthy` |
| `end-to-end` says the stand-in does not answer | The stand-in is started with the stack. If you changed `dev/fake-user-service.ts`, run `docker compose restart user-service-standin` |
| `independent` fails on port 5173 | A web client dev server is running. Stop it, and run the part again |
| `tests` prints a command instead of running | The shell has no `npm` or the packages are not installed. Run `npm install` and `npm test` in `supplier-service` from PowerShell |
| `docker: command not found` in Git Bash | Use PowerShell for the `docker` commands. The script already adds Docker to its own path |
| Counts differ from 21 suppliers | Someone changed the data, or a run in a shell without Docker left an Inactive `Demo Cafe` record. `docker compose down -v` and start again |
| A change you made straight in the database does not show | Search results are kept for 2 seconds. Wait, or change it through the API |
