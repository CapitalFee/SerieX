package books

import "context"

// SessionInfo is the SerieX Books user a session token belongs to.
type SessionInfo struct {
	User    string `json:"user"`
	IsAdmin bool   `json:"isAdmin"`
}

// SessionInfo asks SerieX Books who the AI assistant session token s.Token
// belongs to (GET /api/c/{cid}/session with X-SerieX-Assistant: 1, so an ended
// token gets 401, even in a company without passwords). Used to accept AI
// assistant requests (header X-Books-Session).
func (c *Client) SessionInfo(ctx context.Context, s Session) (SessionInfo, error) {
	s.Assistant = true
	var out SessionInfo
	err := c.cGet(ctx, s, "/session", &out)
	return out, err
}
