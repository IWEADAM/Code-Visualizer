# Security Specification — Code Visualizer (`repoHistory`)

## 1. Data Invariants
1. **Default Deny**: All paths outside `/repoHistory/{repoId}` are strictly denied for both `read` and `write`.
2. **Ownership & Identity Integrity**: A `RepoHistory` document can only be created, read, listed, updated, or deleted by the authenticated user whose `request.auth.uid` matches `ownerId`.
3. **Verified Email Requirement**: All mutating operations (`create`, `update`, `delete`) require `request.auth.token.email_verified == true`.
4. **Strict Key & Size Bounds**: Every `RepoHistory` write must contain the exact 9 required keys (`ownerId`, `name`, `description`, `repoUrl`, `language`, `fileCount`, `filesPayload`, `createdAt`, `updatedAt`) with bounded string lengths matching `firebase-blueprint.json`.
5. **Temporal & Immutable Fields**: `ownerId` and `createdAt` are immutable on `update`; `createdAt` (on create) and `updatedAt` (on create and update) must equal `request.time`.

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated Write**: `auth = null` attempting `create` on `/repoHistory/repo_1`.
2. **Unverified Email Write**: `auth.token.email_verified = false` attempting `create` on `/repoHistory/repo_1`.
3. **Identity Spoofing**: `auth.uid = "user_a"` creating a document with `ownerId: "user_b"`.
4. **Shadow Field Injection**: Payload including an undeclared field `"isAdmin": true`.
5. **Missing Required Field**: Payload omitting `filesPayload` or `language`.
6. **ID Poisoning**: Document ID containing invalid characters or >128 chars.
7. **Oversized Name**: `name` string exceeding `maxLength: 120`.
8. **Oversized Description**: `description` string exceeding `maxLength: 500`.
9. **Client Timestamp Forgery**: `createdAt` or `updatedAt` not matching `request.time`.
10. **Immutable Field Mutation**: Updating `ownerId` or `createdAt` on an existing document.
11. **Cross-User Read/Get**: `auth.uid = "user_b"` attempting `get` on a document owned by `"user_a"`.
12. **Blanket List Query**: `auth.uid = "user_b"` attempting `list` without filtering `ownerId == request.auth.uid`.
