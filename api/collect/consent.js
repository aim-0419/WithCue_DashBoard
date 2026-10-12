import { readJsonBody, requireCollector, sendJson, withHandler } from "../_lib/http.js";
import {
  ensureParticipantDocument,
  ensureUserNumber,
  getUsersCollection,
  parseLocationKey,
} from "../_lib/users.js";

// POST /api/collect/consent — 수집자가 지점에서 처음 수집을 시작할 때 참여 기록을 한 번만 만든다.
async function consentHandler(req, res) {
  const decoded = await requireCollector(req);
  const body = readJsonBody(req);
  const locationKey = parseLocationKey(body.location);

  // users 문서가 없으면 ensureUserNumber가 403 user_missing을 던진다.
  const userRef = getUsersCollection().doc(decoded.userDocId);
  const { userNumber, memberCode } = await ensureUserNumber(userRef);
  const result = await ensureParticipantDocument({
    userDocId: userRef.id,
    userNumber,
    memberCode,
    locationKey,
  });

  sendJson(res, 200, {
    ok: true,
    created: result.created,
    id: result.id,
  });
}

export default withHandler(consentHandler, { methods: ["POST"] });
