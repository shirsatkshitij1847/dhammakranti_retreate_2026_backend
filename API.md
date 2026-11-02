# Retreat API Reference

## Setup

Set these variables in `.env` (see [.env.example](./.env.example)), then run:

| Variable | Purpose |
| -------- | ------- |
| `MONGO_URL` | MongoDB connection string |
| `PORT` | Required listening port, e.g. `3000` |
| `FRONTEND_URL` | Required allowed frontend origin, e.g. `http://localhost:5173` |
| `BACKEND_URL` | Required public backend origin, e.g. `http://localhost:3000`; used for image links |
| `JWT_SECRET` | Required random secret, at least 32 bytes; keep private |
| `ADMIN_EMAIL` | First admin's email address |
| `ADMIN_PASSWORD` | First admin's password: at least 8 characters, at most 72 UTF-8 bytes |

Generate a signing secret locally with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Do not share or commit secrets.

```sh
npm start
```

- Base URL: the configured `BACKEND_URL`. `PORT` controls the listening port.
- Database: `triratnaAkola`.
- Collections: `retreats`, `registrations`, `accounts`, and `blogs`.
- Retreats are created through the admin API, not recreated on startup after deletion.
- Registration creation and retreat deletion require MongoDB transactions
  (Atlas, a replica set, or a sharded cluster; standalone MongoDB is unsupported).
- Send POST requests with `Content-Type: application/json`.
- CORS allows the configured `FRONTEND_URL`, including its
  `/#registration` page. URL fragments are not part of an origin.
- Browser preflight requests support JSON POST, PATCH and DELETE requests,
  including the `Authorization` header.
- Admin-protected endpoints require `Authorization: Bearer <token>`.
- Use HTTPS outside localhost. CORS is not an authentication mechanism.

URL variables must be HTTP(S) origins without paths, queries, or fragments.
For example, use `http://localhost:5173`, not `http://localhost:5173/#registration`.
Restart the backend after changing its environment. Behind a reverse proxy,
`BACKEND_URL` is the public origin and can use a different port from `PORT`.

### Frontend API base URL (Vite)

In the separate frontend project's `.env`, set:

```dotenv
VITE_API_BASE_URL=http://localhost:3000
```

Use the public backend origin for this value. Backend `.env` variables are not
automatically available to the frontend. Never place MongoDB credentials,
JWT signing secrets, or admin passwords in `VITE_` variables.

```js
const API = import.meta.env.VITE_API_BASE_URL;
if (!API) throw new Error("VITE_API_BASE_URL is required");
```

Use `${API}/api/...` for requests instead of hardcoded backend URLs.
Restart the frontend development server, or rebuild for deployment, after changes.

On startup, the configured admin is created if that email is unused. An existing
admin's password is not reset. An existing visitor/organizer is never promoted
automatically by this setup. After creating the first admin, you may remove
`ADMIN_EMAIL` and `ADMIN_PASSWORD`; startup then requires an existing admin.
Keep `JWT_SECRET` configured.

## Accounts and Permissions

Login accounts are separate from retreat registrations. Existing participants
are not automatically login accounts. Registration email remains optional;
account email and password are required. Account passwords are stored as bcrypt
hashes and never returned. Registration `role` stays `visitor` and does not
grant account permissions.

| Operation | Public | Visitor | Organizer | Admin |
| --------- | ------ | ------- | --------- | ----- |
| Health check | Yes | Yes | Yes | Yes |
| List retreats | No | No | Yes | Yes |
| Submit participant registration | No | No | Yes | Yes |
| Sign up / log in | Yes | Yes | Yes | Yes |
| Read own account | No | Yes | Yes | Yes |
| List participants | No | No | Yes | Yes |
| Delete registrations | No | No | No | Yes |
| Create retreats | No | No | No | Yes |
| Delete retreats and all their registrations | No | No | No | Yes |
| List accounts / organizers, change account roles | No | No | No | Yes |

An organizer is an account role, not a separate organization entity. It has no
admin privileges. Signup always creates a visitor. Only an authenticated admin
can promote an account to organizer or admin.

### Waiting for Admin Approval

Anyone can create a login account through signup. New accounts always have role
`visitor` and appear in the admin waiting list. Visitors can log in and read
their own account, but cannot access retreats, participant registration, or
participant lists. An unknown email must sign up first; login never creates an
account automatically.

An admin calls `GET /api/accounts/waiting` to see all visitor accounts, newest
first. It returns an array of `{ "_id", "name", "email", "role" }` objects,
or `[]` when no one is waiting. Passwords and hashes are never returned.
This endpoint returns `401` without login and `403` for non-admins.

Approve an account with `PATCH /api/accounts/:accountId/role` and
`{ "role": "organizer" }`. It then disappears from the waiting list and gains
organizer access. Changing its role back to `visitor` blocks access again and
puts it back in the waiting list. No separate approval status is stored:
`visitor` means waiting, and existing visitor accounts are included.

The frontend must send the login token on each protected API request.
Use `GET /api/auth/me` to check the current role: show the retreat,
registration, and visitor-list pages only to `organizer` or `admin`.
Show role management, retreat creation, and deletion controls only to `admin`.
Redirect unauthenticated users to login; show "Waiting for admin approval"
for visitors after signup/login, rather than the protected pages.
Backend permissions are enforced independently of frontend page visibility.
After an admin changes a role, refresh `/api/auth/me` to update the UI.

## Signup and Login

### POST /api/auth/signup

```json
{
  "name": "Sample Participant",
  "email": "participant@example.com",
  "password": "<your-8-or-more-character-password>"
}
```

Name, valid email, and password are required. Passwords must be at least 8
characters and at most 72 UTF-8 bytes. Email is trimmed and lowercased and must
be unique. `role` may be omitted or `"visitor"`; other roles return `403`.

Success: `201 Created`. Signup and login both return this shape:

```json
{
  "token": "<signed-access-token>",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "account": {
    "_id": "690000000000000000000010",
    "name": "Sample Participant",
    "email": "participant@example.com",
    "role": "visitor"
  }
}
```

### POST /api/auth/login

```json
{
  "email": "participant@example.com",
  "password": "<your-password>"
}
```

Success: `200 OK`, with the same response shape as signup. Invalid credentials
return `401`; missing/malformed credentials return `400`. Authentication
requests share a limit of 20 attempts per IP per 15 minutes (`429` on excess).
The limiter is in-memory per server process.

### GET /api/auth/me

Requires a valid bearer token. Returns the current account's `_id`, `name`,
`email`, and `role` with status `200`.

### GET /api/profile

Returns the currently logged-in account's profile, using the same account
fields as `/api/auth/me`. Available to visitors, organizers, and admins,
including visitors waiting for approval.

Send `Authorization: Bearer <token>`. No body or account ID is needed.
Success: `200 OK`, with `Cache-Control: no-store`:

```json
{
  "_id": "690000000000000000000010",
  "name": "Sample Participant",
  "email": "participant@example.com",
  "role": "visitor"
}
```

Missing, invalid, expired, or revoked tokens return `401`. Passwords and hashes
are never returned. The role is read from the database, so refresh this endpoint
after admin approval. Participant registration details are separate from this
login-account profile. This endpoint cannot retrieve another person's profile.

Tokens expire after one hour. Re-login to obtain a new one. Account roles are
read from the database for every protected request, so role changes apply to
existing tokens. Admin password resets invalidate the target account's existing
tokens. No refresh, self-service password reset, or logout API exists;
client logout removes its token.

## Admin Account and Organizer APIs

All endpoints below require an admin bearer token:

- `GET /api/accounts`: all login accounts, newest first; returns an array of
  `{ "_id", "name", "email", "role" }` objects without password hashes.
- `GET /api/accounts/waiting`: the same shape, restricted to visitors awaiting approval.
- `GET /api/organizers`: the same shape, restricted to accounts with role `organizer`.
- `PATCH /api/accounts/:accountId/role`: change a login account's role.
- `PATCH /api/accounts/:accountId/password`: set/reset an account's password.

Role change request:

```json
{
  "role": "organizer"
}
```

Allowed roles: `visitor`, `organizer`, `admin`. Returns the updated account
with status `200`. Invalid IDs/roles return `400`; missing accounts return
`404`. An admin cannot remove their own admin role.

To create an organizer: create a visitor through signup, then use an admin
token to promote its account `_id` through the PATCH endpoint.
Account IDs are not participant registration IDs.

### Admin Password Settings

**PATCH /api/accounts/:accountId/password**

Requires an admin bearer token. Visitors and organizers receive `403`;
unauthenticated requests receive `401`. Only admins can manage passwords
and assign organizer/admin roles.

```json
{
  "password": "<new-password-at-least-8-characters>"
}
```

Use the login account `_id` from `GET /api/accounts`, not a registration ID.
The password must contain at least 8 characters and at most 72 UTF-8 bytes.
Success: `204 No Content` with no response body. Invalid IDs/passwords return
`400`; an unknown account returns `404`.

The new password is hashed, never returned or displayed. The old password and
all existing tokens for that account stop working. The account must log in
again. Resetting your own admin password also invalidates your current token.
This operation does not change roles or participant registrations.
Saved passwords cannot be retrieved; an admin can only replace them.

## Blog APIs (MongoDB Images)

Each blog stores one image as binary data together with title, plain text,
and author in MongoDB. No external storage, local image files, or additional
environment variables are needed. Images are limited to 5 MB so documents stay
below MongoDB's 16 MB limit. Include image storage in database backups/capacity.

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `/api/blogs?page=1&limit=10` | Public |
| GET | `/api/blogs/:blogId` | Public |
| GET | `/api/blogs/:blogId/image` | Public image bytes |
| POST | `/api/blogs` | Organizer/admin |
| PATCH | `/api/blogs/:blogId` | Original author (organizer) or any admin |
| DELETE | `/api/blogs/:blogId` | Original author (organizer) or any admin |

### Create or edit

Send a bearer token and `multipart/form-data`:

- `title`: required on creation, non-blank, maximum 200 characters.
- `text`: required on creation, non-blank, maximum 20,000 characters.
- `image`: required on creation; one JPEG, PNG, or WebP file, maximum 5 MB.

PATCH accepts any of these fields but requires at least one. Authentication
and ownership are checked before processing uploads. Author ID is taken from
the logged-in account, never the submitted form.

Example frontend request:

```js
const data = new FormData();
data.append("title", title);
data.append("text", text);
data.append("image", selectedFile);
const API = import.meta.env.VITE_API_BASE_URL;
if (!API) throw new Error("VITE_API_BASE_URL is required");
const response = await fetch(`${API}/api/blogs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: data,
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
```

Do not manually set `Content-Type` for FormData; the browser adds its boundary.
Images are decoded and re-encoded as WebP, removing metadata. Animated images,
SVG, other formats, invalid image data, and images over 25 megapixels are rejected.
Both uploaded and processed image sizes must be at most 5 MB.

Create returns `201`; edit/detail returns `200`, with this shape:

```json
{
  "_id": "690000000000000000000020",
  "title": "Our Retreat",
  "text": "Text displayed below the image.",
  "authorId": "690000000000000000000010",
  "imageUrl": "http://localhost:3000/api/blogs/690000000000000000000020/image",
  "createdAt": "2026-11-02T15:30:00.000Z",
  "updatedAt": "2026-11-02T15:30:00.000Z"
}
```

List returns an array of the same objects, newest first; `[]` if empty.
`page` defaults to 1; `limit` defaults to 10 and must be 1-50.
Image bytes are excluded from JSON. `imageUrl` is an absolute URL built from
`BACKEND_URL`; use it directly as the image source. Display text as plain text
(not unsanitized HTML). All posts are immediately public, with no draft workflow.

Delete returns `204` with no body and removes the blog and image together.
Invalid inputs/IDs return `400`; missing posts return `404`; missing/invalid
login returns `401`; insufficient permissions return `403`; oversized images
return `413`. Unexpected storage errors return `500`.

## Retreat and Account Endpoint Summary

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/` | Check that the backend is running |
| GET | `/heath` | Check HTTP availability; returns an empty JSON object |
| POST | `/api/auth/signup` | Create a visitor login account |
| POST | `/api/auth/login` | Obtain a bearer token |
| GET | `/api/auth/me` | Read the authenticated account |
| GET | `/api/profile` | Read your own profile (any logged-in role) |
| GET | `/api/accounts` | Admin: list login accounts |
| GET | `/api/accounts/waiting` | Admin: list visitors waiting for organizer approval |
| GET | `/api/organizers` | Admin: list organizer accounts |
| PATCH | `/api/accounts/:accountId/role` | Admin: change an account role |
| PATCH | `/api/accounts/:accountId/password` | Admin: set/reset an account password |
| GET | `/api/users` | Organizer/admin: list all participant registrations with retreat details |
| DELETE | `/api/users/:userId` | Admin: permanently delete one participant registration |
| GET | `/api/retreats` | Organizer/admin: list retreats |
| POST | `/api/retreats` | Admin: create a retreat |
| DELETE | `/api/retreats/:retreatId` | Admin: delete a retreat and all its registrations |
| POST | `/api/retreats/:retreatId/registrations` | Organizer/admin: register a participant |
| GET | `/api/retreats/:retreatId/registrations` | Organizer/admin: list a retreat's registrations |

Replace `:retreatId` with the `_id` returned by the retreat endpoints.

## 1. Check Backend

**GET /**

Success: `200 OK`, plain text:

```text
Backend is running
```

### Health Check

**GET /heath**

Success: `200 OK`, with `Content-Type: application/json`:

```json
{}
```

Checks that the HTTP server responds without returning participant data or
querying MongoDB. This is not a database health check. The path is `/heath`
as requested.

## 2. List Retreats

**GET /api/retreats**

Requires an organizer or admin bearer token.

Success: `200 OK`. Returns an array sorted by year descending, then name ascending.

Example response:

```json
[
  {
    "_id": "690000000000000000000001",
    "name": "Retreat",
    "year": 2026,
    "createdAt": "2026-11-02T15:30:00.000Z",
    "updatedAt": "2026-11-02T15:30:00.000Z"
  }
]
```

## 3. Create a Retreat

**POST /api/retreats**

Requires an admin bearer token.

Request body:

```json
{
  "name": "Winter Retreat",
  "year": 2027
}
```

| Field | Type | Required | Rules |
| ----- | ---- | -------- | ----- |
| `name` | String | Yes | Non-empty; surrounding whitespace is trimmed |
| `year` | Number | Yes | Integer, at least 2000 |

Success: `201 Created`. Returns the saved retreat document, including `_id` and timestamps.

The same name/year combination must be unique. Different retreats can share a year.
Use this endpoint for future years instead of creating a new database or collection.

## 4. Register a Participant

**POST /api/retreats/:retreatId/registrations**

Requires an organizer or admin bearer token.

Request body:

```json
{
  "name": "Sample",
  "middleName": "Middle",
  "surname": "Participant",
  "role": "visitor",
  "mobileNumber": "9000000000",
  "email": "participant@example.com",
  "center": "Akola",
  "centerPayment": "500",
  "address": "Akola, Maharashtra"
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | String | Yes | First name |
| `middleName` | String | No | Defaults to an empty string when omitted |
| `surname` | String | Yes | Surname |
| `role` | String | No | Defaults to `visitor` when omitted; only `visitor` is currently supported |
| `mobileNumber` | String | Yes | Send as text to preserve leading zeros or `+` |
| `email` | String | No | May be omitted or empty; stored lowercase when supplied |
| `center` | String | Yes | Participant's center |
| `centerPayment` | String | Yes | Payment text, separate from `center` |
| `address` | String | Yes | Participant address |

Required string fields cannot be blank. Surrounding whitespace is trimmed.
Email format and mobile number format are not currently validated.
`centerPayment` is not validated as a numeric amount or used to process payments.

Success: `201 Created`. Example response:

```json
{
  "_id": "690000000000000000000002",
  "retreatId": "690000000000000000000001",
  "name": "Sample",
  "middleName": "Middle",
  "surname": "Participant",
  "role": "visitor",
  "mobileNumber": "9000000000",
  "email": "participant@example.com",
  "center": "Akola",
  "centerPayment": "500",
  "address": "Akola, Maharashtra",
  "createdAt": "2026-11-02T15:35:00.000Z",
  "updatedAt": "2026-11-02T15:35:00.000Z",
  "__v": 0
}
```

The retreat must exist. `retreatId` is taken from the URL, not the request body.
Repeated registrations are currently allowed, including the same mobile number.
Each registration receives a unique MongoDB `_id`, independently of the phone number.
This identifies a registration, not a person across retreats, and does not prevent
the same person from submitting twice. Names and centers are not unique.
Existing registrations created before `center` was added may lack this field;
new submissions require it.
Existing records without `middleName` or `role` are returned with the schema
defaults (`""` and `"visitor"`) when read through these endpoints; saved data is
not bulk modified. Explicit `null`, empty, or unsupported roles are rejected
on new submissions.

## 5. List Registrations

**GET /api/retreats/:retreatId/registrations**

Requires an organizer or admin bearer token.

Success: `200 OK`. Returns an array of registration documents, newest first,
in the same shape as the registration response above.

Returns `[]` when there are no matching registrations, including when a
valid-format retreat ID does not exist. This endpoint has no pagination.

## 6. List All Users and Details

**GET /api/users**

Requires an organizer or admin bearer token.

Success: `200 OK`. Returns all registration documents, newest first, including
name, middle name, surname, role, mobile number, optional email, center, center payment, address,
unique `_id`, and timestamps. Returns `[]` if there are no registrations.

Example full response (the `retreatId` field contains the retreat's `_id`,
`name`, and `year` instead of just its ID):

```json
[
  {
    "_id": "690000000000000000000002",
    "retreatId": {
      "_id": "690000000000000000000001",
      "name": "Retreat",
      "year": 2026
    },
    "name": "Sample",
    "middleName": "Middle",
    "surname": "Participant",
    "role": "visitor",
    "mobileNumber": "9000000000",
    "email": "participant@example.com",
    "center": "Akola",
    "centerPayment": "500",
    "address": "Akola, Maharashtra",
    "createdAt": "2026-11-02T15:35:00.000Z",
    "updatedAt": "2026-11-02T15:35:00.000Z",
    "__v": 0
  }
]
```

If a referenced retreat no longer exists, `retreatId` is `null`.
This is a list of registrations, not deduplicated people: a person registered
for multiple retreats appears multiple times. There is no pagination.

## 7. Delete a User Registration

**DELETE /api/users/:userId**

Requires an admin bearer token.

Replace `:userId` with the registration's top-level `_id` from `GET /api/users`,
not the nested retreat ID. No request body is required.

Example:

```http
DELETE /api/users/690000000000000000000002
```

Success: `204 No Content`, with an empty response body. Do not parse it as JSON.
Remove that registration from the displayed list after a successful response.

This permanently deletes only the selected registration. It does not delete the
retreat or any other registrations, even for the same person.

- `400 Bad Request`: `{ "error": "Invalid user ID" }`
- `404 Not Found`: `{ "error": "User not found" }`, including a repeated deletion.

There is no undo. Ask for confirmation in the UI before sending a deletion request.

## 8. Delete a Retreat and Its Registrations

**DELETE /api/retreats/:retreatId**

Requires an admin bearer token. No body is required.
Use the retreat `_id` from `GET /api/retreats`.

Success: `204 No Content` with an empty body. Permanently deletes the retreat
and every registration belonging to it in one database transaction.
Other retreats, their registrations, and login accounts are not deleted.
Concurrent registration submissions cannot leave orphan registrations.

- `400`: invalid retreat ID.
- `401`: login required or token invalid.
- `403`: account is not an admin.
- `404`: retreat not found, including repeated deletion.
- `500`: database operation failed; the transaction is rolled back.

Ask for explicit confirmation in the UI: this has no undo.
Deleted retreats, including Retreat 2026, are not recreated on server restart.
Existing retreats remain unchanged until explicitly deleted.

## Unique IDs Without Phone Numbers

- MongoDB automatically generates a unique `_id` for each registration.
- Do not send an `_id` when registering; use the ID returned by the API.
- Mobile numbers remain required contact information, but are not unique.
- Matching names, surnames, and centers are allowed because different people
  can share those details.
- There is no separate permanent person ID or duplicate-person detection.
  Registering again creates a different registration `_id`.

## Error Responses

Errors use this JSON shape:

```json
{
  "error": "Invalid retreat ID"
}
```

| Status | Meaning |
| ------ | ------- |
| `400 Bad Request` | Invalid retreat/user ID, schema validation failure, or invalid field cast |
| `401 Unauthorized` | Missing/invalid/expired bearer token, or incorrect login credentials |
| `403 Forbidden` | Admin access required, or an elevated role requested during signup |
| `404 Not Found` | Retreat does not exist when submitting a registration, or user registration does not exist when deleting |
| `409 Conflict` | Retreat name/year combination or account email already exists |
| `429 Too Many Requests` | Authentication attempt limit exceeded |
| `500 Internal Server Error` | Unexpected server error |

Validation error messages describe the failing fields. Unknown routes use
Express's default 404 response rather than the JSON error shape above.

## Typical Form Flow

1. Call `GET /api/retreats` to populate the retreat selector.
2. Keep the selected retreat's `_id`.
3. Collect name, surname, mobile number, center, center payment, and address;
   email is optional.
4. Submit to `POST /api/retreats/<selected-id>/registrations`.
5. Treat `201 Created` as successful registration; display the returned error otherwise.
6. Use `GET /api/users` to view all registrations with retreat details, or
   `GET /api/retreats/<selected-id>/registrations` for one retreat only.

For another retreat or year, create it through `POST /api/retreats`, then use its
`_id` for registration. Delete a registration with `DELETE /api/users/<registration-id>`.
Participant update endpoints are not currently implemented; account role updates
are supported as described above.
