package company

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Sessions live in memory: token -> company file id + user id. Restarting the
// server logs everybody out. A session ends after sessionIdle without use, and
// after sessionMax in any case.
type session struct {
	companyID    string
	fileUID      string // store.FileUID of the file logged in to
	userID       int64
	created      time.Time
	lastUsed     time.Time
	maxAge       time.Duration // ends this long after it was made (0: sessionMax)
	assistant    assistantKind // a session of AI assistants (see assistant.go)
	allowChanges bool          // assistant sessions: an administrator allowed changes
	noPasswords  bool          // assistant sessions: made while the file had no passwords
}

const (
	sessionIdle = 12 * time.Hour
	sessionMax  = 7 * 24 * time.Hour
)

var (
	sessMu   sync.Mutex
	sessions = map[string]*session{}
)

func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *session) expired(now time.Time) bool {
	max := sessionMax
	if s.maxAge > 0 {
		max = s.maxAge
	}
	return now.Sub(s.lastUsed) > sessionIdle || now.Sub(s.created) > max
}

// peekSession returns the session of a token without counting it as used.
func peekSession(tok string) (session, bool) {
	sessMu.Lock()
	defer sessMu.Unlock()
	s, ok := sessions[tok]
	if !ok || s.expired(time.Now()) {
		return session{}, false
	}
	return *s, true
}

// lookupSession returns the session of a token (and counts it as used).
func lookupSession(tok string) (session, bool) {
	sessMu.Lock()
	defer sessMu.Unlock()
	s, ok := sessions[tok]
	if !ok {
		return session{}, false
	}
	now := time.Now()
	if s.expired(now) {
		delete(sessions, tok)
		return session{}, false
	}
	s.lastUsed = now
	return *s, true
}

// addSession stores a new session and forgets the expired ones.
func addSession(s session) string {
	tok := newToken()
	now := time.Now()
	s.created, s.lastUsed = now, now
	sessMu.Lock()
	defer sessMu.Unlock()
	for t, old := range sessions {
		if old.expired(now) {
			delete(sessions, t)
		}
	}
	sessions[tok] = &s
	return tok
}

func dropSession(tok string) {
	sessMu.Lock()
	defer sessMu.Unlock()
	delete(sessions, tok)
}

// dropUserSessions logs a user out everywhere (user deleted or made inactive,
// password changed) except the session keep ("" = none).
func dropUserSessions(companyID string, userID int64, keep ...string) {
	sessMu.Lock()
	defer sessMu.Unlock()
	for tok, s := range sessions {
		if s.companyID == companyID && s.userID == userID && (len(keep) == 0 || tok != keep[0]) {
			delete(sessions, tok)
		}
	}
}

// dropCompanySessions logs everybody out of a company file id (the file was
// deleted, replaced or re-created).
func dropCompanySessions(companyID string) {
	sessMu.Lock()
	defer sessMu.Unlock()
	for tok, s := range sessions {
		if s.companyID == companyID {
			delete(sessions, tok)
		}
	}
}

// sessionUser returns the active user of a valid X-Session token of this
// company file and its session (ok false when there is none).
func sessionUser(r *http.Request, companyID string, db *sql.DB) (name string, admin bool, sess session, ok bool, err error) {
	ctx := r.Context()
	tok := strings.TrimSpace(r.Header.Get("X-Session"))
	if tok == "" {
		return "", false, sess, false, nil
	}
	s, found := lookupSession(tok)
	if !found || s.companyID != companyID {
		return "", false, sess, false, nil
	}
	// Only a real identity change (file replaced by a restore or copy) ends the session;
	// a failed read (e.g. the browser canceled the request) must not log the user out.
	uid, err := store.FileUIDErr(ctx, db)
	if err != nil {
		return "", false, sess, false, err
	}
	if s.fileUID != uid {
		dropSession(tok)
		return "", false, sess, false, nil
	}
	if s.assistant != notAssistant && s.noPasswords {
		// made while the file had no passwords, when its payroll token could
		// go to a program that did not prove it is SerieX Payroll: it ends as
		// soon as the file has a password, however the password was set
		req, err := authRequired(ctx, db)
		if err != nil {
			return "", false, sess, false, err
		}
		if req {
			dropSession(tok)
			return "", false, sess, false, nil
		}
	}
	var isAdm int
	err = db.QueryRowContext(ctx, `SELECT name, is_admin FROM users WHERE id = ? AND active = 1`, s.userID).Scan(&name, &isAdm)
	if errors.Is(err, sql.ErrNoRows) {
		dropSession(tok)
		return "", false, sess, false, nil
	}
	if err != nil {
		return "", false, sess, false, err
	}
	return name, isAdm == 1, s, true, nil
}

// sessionInfo is installed as rt.Session for the global company file routes.
func sessionInfo(r *http.Request, companyID string, db *sql.DB) (httpx.SessionInfo, error) {
	var si httpx.SessionInfo
	req, err := authRequired(r.Context(), db)
	if err != nil {
		return si, err
	}
	si.Required = req
	name, admin, sess, ok, err := sessionUser(r, companyID, db)
	if err != nil {
		return si, err
	}
	if ok && sess.assistant == notAssistant { // AI assistants never back up, copy or delete company files
		si.User, si.Admin = name, admin
	}
	if !req {
		si.Admin = true
		if si.User == "" {
			si.User = "Admin"
		}
	}
	return si, nil
}

// authRequired: a login is needed as soon as one active user has a password.
func authRequired(ctx context.Context, q store.Q) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE active = 1 AND password_hash <> ''`).Scan(&n)
	return n > 0, err
}

// authenticate is installed as rt.Auth. A valid session of this company gives
// its user; otherwise, when no user has a password, everybody is "Admin",
// except the requests of the AI assistant connection (assistantHeader): they
// need a valid session of AI assistants, also in a file without passwords.
func authenticate(r *http.Request, companyID string, db *sql.DB) (string, error) {
	ctx := r.Context()
	name, _, sess, ok, err := sessionUser(r, companyID, db)
	if err != nil {
		return "", err
	}
	marked := r.Header.Get(assistantHeader) != ""
	if ok {
		if sess.assistant != notAssistant {
			if err := checkAssistantRequest(r, sess); err != nil {
				return "", err
			}
		} else if marked {
			return "", apperr.Auth("%s", msgAssistantLogin) // never a person's login
		}
		return name, nil
	}
	if marked {
		// the login of AI assistants is missing or ended (access turned off,
		// another user chosen, expired...): never "Admin"; the tools ask for
		// a new login, which is checked against the settings again
		return "", apperr.Auth("%s", msgAssistantLogin)
	}
	req, err := authRequired(ctx, db)
	if err != nil {
		return "", err
	}
	if !req {
		return "Admin", nil
	}
	return "", apperr.Auth("Please log in.")
}

// isAdmin reports whether user may do administrator tasks. Without passwords
// everybody works as the administrator.
func isAdmin(ctx context.Context, q store.Q, user string) (bool, error) {
	return store.IsAdmin(ctx, q, user)
}

func forbidden(msg string) error {
	return apperr.Forbidden("%s", msg)
}

// checkLogin checks a user name and password of a company file. Repeated
// failures lock that user name out for a while (other users can still log in).
// While a login is required, a user without a password cannot log in; the only
// exception is an administrator of an older file in which no administrator has
// a password yet (otherwise nobody could manage its users any more).
// Old SHA-256 password hashes are upgraded to bcrypt on success.
func checkLogin(ctx context.Context, companyID string, db *sql.DB, user, password string) (int64, string, bool, error) {
	user = strings.TrimSpace(user)
	userKey := "login:" + companyID + ":" + strings.ToLower(user)
	if err := store.PasswordTry(userKey, 5); err != nil {
		return 0, "", false, err
	}
	var id int64
	var name, hash string
	var isAdm int
	err := db.QueryRowContext(ctx, `SELECT id, name, password_hash, is_admin FROM users WHERE name = ? AND active = 1`, user).
		Scan(&id, &name, &hash, &isAdm)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, err
	}
	if err != nil || !store.CheckPassword(hash, password) {
		store.PasswordWrong()
		return 0, "", false, apperr.Validation("password", "The user name or password you entered is not correct. Please try again.")
	}
	if hash == "" {
		required, err := authRequired(ctx, db)
		if err != nil {
			return 0, "", false, err
		}
		if required {
			adminsWithPassword, err := activeAdminsWithPassword(ctx, db)
			if err != nil {
				return 0, "", false, err
			}
			if isAdm != 1 || adminsWithPassword > 0 {
				return 0, "", false, apperr.Validation("password", "%s has no password yet and cannot log in. Ask an administrator to give %s a password.", name, name)
			}
		}
	}
	store.PasswordOK(userKey)
	if store.PasswordNeedsUpgrade(hash) {
		db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`, store.HashPassword(password), id, hash)
	}
	return id, name, isAdm == 1, nil
}

func registerAuth(rt *httpx.Router) {
	rt.Auth = authenticate
	rt.Context = assistantContext
	rt.Session = sessionInfo
	rt.FileReplaced = dropCompanySessions
	rt.Login = func(ctx context.Context, companyID string, db *sql.DB, user, password string) (httpx.SessionInfo, error) {
		_, name, admin, err := checkLogin(ctx, companyID, db, user, password)
		if err != nil {
			return httpx.SessionInfo{}, err
		}
		return httpx.SessionInfo{Required: true, User: name, Admin: admin}, nil
	}

	// GET /api/companies/{id}/auth -> {required, users}
	rt.Handle("GET", "/api/companies/{id}/auth", func(w http.ResponseWriter, r *http.Request) error {
		db, err := rt.DBs.Open(r.PathValue("id"))
		if err != nil {
			return apperr.NotFound("Company file not found or could not be opened: %v", err)
		}
		ctx := r.Context()
		req, err := authRequired(ctx, db)
		if err != nil {
			return err
		}
		users := []string{}
		if !httpx.FromThisComputer(r) {
			// someone on another computer (the server listens on the network) types the user name
			return httpx.WriteJSON(w, http.StatusOK, map[string]any{"required": req, "users": users})
		}
		rows, err := db.QueryContext(ctx, `SELECT name FROM users WHERE active = 1 ORDER BY is_admin DESC, name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				return err
			}
			users = append(users, n)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return httpx.WriteJSON(w, http.StatusOK, map[string]any{"required": req, "users": users})
	})

	// POST /api/companies/{id}/login body {user, password} -> {token, user}
	rt.Handle("POST", "/api/companies/{id}/login", func(w http.ResponseWriter, r *http.Request) error {
		companyID := r.PathValue("id")
		db, err := rt.DBs.Open(companyID)
		if err != nil {
			return apperr.NotFound("Company file not found or could not be opened: %v", err)
		}
		var body struct {
			User     string `json:"user"`
			Password string `json:"password"`
		}
		if err := httpx.DecodeJSON(r, &body); err != nil {
			return err
		}
		id, name, _, err := checkLogin(r.Context(), companyID, db, body.User, body.Password)
		if err != nil {
			return err
		}
		uid, err := store.FileUIDErr(r.Context(), db)
		if err != nil {
			return err
		}
		tok := addSession(session{companyID: companyID, fileUID: uid, userID: id})
		return httpx.WriteJSON(w, http.StatusOK, map[string]any{"token": tok, "user": name})
	})

	// POST /api/c/{cid}/logout: registered as a plain route so it works without a valid session.
	rt.Handle("POST", "/api/c/{cid}/logout", func(w http.ResponseWriter, r *http.Request) error {
		if tok := strings.TrimSpace(r.Header.Get("X-Session")); tok != "" {
			dropSession(tok)
		}
		return httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
}

// ---------------------------------------------------------------------------
// Users

func registerUsers(rt *httpx.Router) {
	rt.C("GET", "/users", listUsers)
	rt.C("POST", "/users", createUser)
	rt.C("PUT", "/users/{id}", updateUser)
	rt.C("DELETE", "/users/{id}", deleteUser)
}

func loadUsers(ctx context.Context, q store.Q, where string, args ...any) ([]model.User, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, is_admin, active, password_hash <> '' FROM users `+where+` ORDER BY is_admin DESC, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.User{}
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Name, &u.IsAdmin, &u.Active, &u.HasPassword); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func loadUser(ctx context.Context, q store.Q, id int64) (model.User, error) {
	us, err := loadUsers(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.User{}, err
	}
	if len(us) == 0 {
		return model.User{}, apperr.NotFound("User not found.")
	}
	return us[0], nil
}

// userInput accepts the model.User fields plus "active" as optional (defaults
// to true on create) and "clearPassword" to remove a password.
type userInput struct {
	model.User
	Active        *bool `json:"active"`
	ClearPassword bool  `json:"clearPassword"`
}

// listUsers: administrators see every user, other users only themselves.
func listUsers(c *httpx.Ctx) error {
	admin, err := isAdmin(c.Context(), c.DB, c.User)
	if err != nil {
		return err
	}
	var us []model.User
	if admin {
		us, err = loadUsers(c.Context(), c.DB, "")
	} else {
		us, err = loadUsers(c.Context(), c.DB, `WHERE name = ?`, c.User)
	}
	if err != nil {
		return err
	}
	return c.JSON(us)
}

func checkUserName(ctx context.Context, q store.Q, name string, exceptID int64) error {
	if name == "" {
		return apperr.Validation("name", "User name is required.")
	}
	if len(name) > 60 {
		return apperr.Validation("name", "User name is too long.")
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE name = ? AND id <> ?`, name, exceptID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apperr.Validation("name", "The user name %q is already in use. Please choose a different name.", name)
	}
	return nil
}

func activeAdmins(ctx context.Context, q store.Q, exceptID int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_admin = 1 AND active = 1 AND id <> ?`, exceptID).Scan(&n)
	return n, err
}

func activeAdminsWithPassword(ctx context.Context, q store.Q) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_admin = 1 AND active = 1 AND password_hash <> ''`).Scan(&n)
	return n, err
}

// checkAdminPasswords runs after a change of the users (inside its
// transaction): as soon as one active user has a password, a login is
// required, and then an active administrator must have a password too.
// Users without a password cannot log in while a login is required, so
// without it nobody could manage the users any more (and older files that
// let an administrator in without a password stay open to anybody).
func checkAdminPasswords(ctx context.Context, tx *sql.Tx) error {
	required, err := authRequired(ctx, tx)
	if err != nil || !required {
		return err
	}
	n, err := activeAdminsWithPassword(ctx, tx)
	if err != nil || n > 0 {
		return err
	}
	name := "Admin"
	tx.QueryRowContext(ctx, `SELECT name FROM users WHERE is_admin = 1 AND active = 1 ORDER BY id LIMIT 1`).Scan(&name)
	return apperr.Validation("password", "Give the administrator %s a password first. Once any user has a password, everybody logs in with a password, so an administrator needs one to manage the users.", name)
}

func createUser(c *httpx.Ctx) error {
	var in userInput
	if err := c.Decode(&in); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.User
	err := c.Write(func(tx *sql.Tx) error {
		admin, err := isAdmin(ctx, tx, c.User)
		if err != nil {
			return err
		}
		if !admin {
			return forbidden("Only an administrator can set up users.")
		}
		name := strings.TrimSpace(in.Name)
		if err := checkUserName(ctx, tx, name, 0); err != nil {
			return err
		}
		active := true
		if in.Active != nil {
			active = *in.Active
		}
		if err := store.CheckNewPassword("password", in.Password); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO users(name, password_hash, is_admin, active, created_at) VALUES(?,?,?,?,?)`,
			name, store.HashPassword(in.Password), store.B(in.IsAdmin), store.B(active), store.Now())
		if err != nil {
			return err
		}
		if err := checkAdminPasswords(ctx, tx); err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		out, err = loadUser(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

func updateUser(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var in userInput
	if err := c.Decode(&in); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.User
	deactivated, pwChanged, self := false, false, false
	err = c.Write(func(tx *sql.Tx) error {
		cur, err := loadUser(ctx, tx, id)
		if err != nil {
			return err
		}
		admin, err := isAdmin(ctx, tx, c.User)
		if err != nil {
			return err
		}
		self = strings.EqualFold(cur.Name, c.User)
		if !admin && !self {
			return forbidden("Only an administrator can change other users.")
		}
		name, isAdm, active := cur.Name, cur.IsAdmin, cur.Active
		if admin {
			if n := strings.TrimSpace(in.Name); n != "" {
				name = n
			}
			isAdm = in.IsAdmin
			if in.Active != nil {
				active = *in.Active
			}
		}
		if err := checkUserName(ctx, tx, name, id); err != nil {
			return err
		}
		if cur.IsAdmin && cur.Active && (!isAdm || !active) {
			n, err := activeAdmins(ctx, tx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return apperr.Conflict("%s is the only active administrator. Another active administrator is required.", cur.Name)
			}
		}
		var hash string
		if err := tx.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, id).Scan(&hash); err != nil {
			return err
		}
		if in.ClearPassword {
			pwChanged = hash != ""
			hash = ""
		} else if in.Password != "" {
			if err := store.CheckNewPassword("password", in.Password); err != nil {
				return err
			}
			hash = store.HashPassword(in.Password)
			pwChanged = true
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET name = ?, password_hash = ?, is_admin = ?, active = ? WHERE id = ?`,
			name, hash, store.B(isAdm), store.B(active), id); err != nil {
			return err
		}
		if err := checkAdminPasswords(ctx, tx); err != nil {
			return err
		}
		deactivated = cur.Active && !active
		out, err = loadUser(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	if deactivated {
		dropUserSessions(c.CompanyID, id)
	} else if pwChanged {
		// a new or reset password logs the user out everywhere else
		keep := ""
		if self {
			keep = strings.TrimSpace(c.R.Header.Get("X-Session"))
		}
		dropUserSessions(c.CompanyID, id, keep)
	}
	return c.JSON(out)
}

func deleteUser(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		admin, err := isAdmin(ctx, tx, c.User)
		if err != nil {
			return err
		}
		if !admin {
			return forbidden("Only an administrator can delete users.")
		}
		cur, err := loadUser(ctx, tx, id)
		if err != nil {
			return err
		}
		if cur.IsAdmin && cur.Active {
			n, err := activeAdmins(ctx, tx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return apperr.Conflict("%s is the only active administrator and cannot be deleted.", cur.Name)
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id); err != nil {
			return err
		}
		return checkAdminPasswords(ctx, tx)
	})
	if err != nil {
		return err
	}
	dropUserSessions(c.CompanyID, id)
	return c.NoContent()
}
