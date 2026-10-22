//go:build ignore

// gen writes the release files of the seriex-mcp program for AI assistant
// apps. build.sh runs it from the mcp folder:
//
//	go run ./packaging/gen.go manifest -version 2026.10.3 -platform darwin -binary seriex-mcp -out <dir>/manifest.json
//	go run ./packaging/gen.go server-json -version 2026.10.3 -out <dir>/server.json <file.mcpb>...
//
// manifest fills packaging/manifest.json for one platform and adds the tools
// read from the source (every def(...) call in seriexmcp and the tools
// cmd/seriex-mcp adds itself), so the list always matches the program.
// server-json writes the entry for the MCP Registry with one package per
// .mcpb file and prints each file's size and SHA-256.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// The MCP Registry entry. The name starts with the GitHub owner written
// exactly as GitHub writes it ("CapitalFee"): the registry only lets the
// owner's administrators publish names that start with it, letter case
// included.
const (
	registryName        = "io.github.CapitalFee/seriex"
	registryTitle       = "SerieX"
	registryDescription = "Lets AI assistants use your SerieX Books and SerieX Payroll company files on this computer."
	registrySchema      = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
	repoURL             = "https://github.com/CapitalFee/SerieX"
	repoSubfolder       = "mcp"
)

var versionRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

func main() {
	if len(os.Args) < 2 {
		fail("usage: gen.go manifest|server-json [options]")
	}
	var err error
	switch os.Args[1] {
	case "manifest":
		err = manifestCmd(os.Args[2:])
	case "server-json":
		err = serverJSONCmd(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q (use manifest or server-json)", os.Args[1])
	}
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "gen.go:", msg)
	os.Exit(1)
}

func checkVersion(v string) error {
	if !versionRe.MatchString(v) {
		return fmt.Errorf("version %q must look like 2026.10.3 (no leading v)", v)
	}
	return nil
}

// ---------------------------------------------------------------------------
// manifest.json

func manifestCmd(args []string) error {
	fs := flag.NewFlagSet("manifest", flag.ContinueOnError)
	version := fs.String("version", "", "release version")
	platform := fs.String("platform", "", "darwin or win32")
	binary := fs.String("binary", "", "file name of the program in server/")
	template := fs.String("template", "packaging/manifest.json", "manifest template")
	lib := fs.String("lib", "seriexmcp", "folder of the seriexmcp package")
	helper := fs.String("helper", "cmd/seriex-mcp", "folder of the seriex-mcp program")
	out := fs.String("out", "", "manifest file to write")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := checkVersion(*version); err != nil {
		return err
	}
	if *platform != "darwin" && *platform != "win32" {
		return fmt.Errorf("platform must be darwin or win32 (it is %q)", *platform)
	}
	if *binary == "" || strings.ContainsAny(*binary, `/\`) || *out == "" {
		return errors.New("-binary (a file name) and -out are required")
	}
	tools, err := readTools(*lib, *helper)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*template)
	if err != nil {
		return err
	}
	m, err := parseOrdered(raw)
	if err != nil {
		return fmt.Errorf("%s: %w", *template, err)
	}
	list := make([]any, 0, len(tools))
	for _, t := range tools {
		list = append(list, object{{"name", t.name}, {"description", t.oneLine()}})
	}
	for _, s := range []struct {
		path  []string
		value any
	}{
		{[]string{"version"}, *version},
		{[]string{"server", "entry_point"}, "server/" + *binary},
		{[]string{"server", "mcp_config", "command"}, "${__dirname}/server/" + *binary},
		{[]string{"compatibility", "platforms"}, []any{*platform}},
		{[]string{"tools"}, list},
	} {
		if err := set(m, s.path, s.value); err != nil {
			return fmt.Errorf("%s: %w", *template, err)
		}
	}
	return os.WriteFile(*out, encodeOrdered(m), 0o644)
}

// tool is a tool as defined in the source.
type tool struct {
	name, desc string
	group      string // groupBooks, groupPayroll, groupWrite or helper
	file       string
	pos        int
}

// oneLine is the first sentence of the tool's description, with a note for
// the tools that are not always offered.
func (t tool) oneLine() string {
	s := strings.Join(strings.Fields(t.desc), " ")
	if i := strings.Index(s, ". "); i >= 0 {
		s = s[:i+1]
	}
	if !strings.HasSuffix(s, ".") {
		s += "."
	}
	switch t.group {
	case "groupPayroll":
		s += " Needs SerieX Payroll to be open."
	case "groupWrite":
		s += " Only where an administrator allows changes."
	}
	return s
}

// groupOrder is the order of the tools in the manifest. "helper" is a tool
// of the seriex-mcp program itself.
var groupOrder = map[string]int{"groupBooks": 0, "groupPayroll": 1, "groupWrite": 2, "helper": 3}

// readTools finds the tools of the seriexmcp package (every def(s, group,
// kind, "name", "title", "description"..., ...) call in libDir) and those
// the seriex-mcp program adds itself (&mcp.Tool{Name: ...} in helperDir).
func readTools(libDir, helperDir string) ([]tool, error) {
	fset := token.NewFileSet()
	var tools []tool
	var problems []string
	lib, err := parseDir(fset, libDir)
	if err != nil {
		return nil, err
	}
	for _, f := range lib {
		ast.Inspect(f.file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || !isDef(call.Fun) {
				return true
			}
			where := fset.Position(call.Pos()).String()
			if len(call.Args) < 6 {
				problems = append(problems, where+": def(...) has fewer arguments than expected")
				return true
			}
			t := tool{file: f.name, pos: int(call.Pos())}
			group, _ := call.Args[1].(*ast.Ident)
			if group != nil {
				t.group = group.Name
			}
			var ok1, ok2, ok3 bool
			t.name, ok1 = stringLit(call.Args[3])
			_, ok2 = stringLit(call.Args[4]) // the title
			t.desc, ok3 = leadingText(call.Args[5])
			if _, known := groupOrder[t.group]; !known || t.group == "helper" || !ok1 || !ok2 || !ok3 {
				problems = append(problems, where+": cannot read the group, name, title or description of a tool (update packaging/gen.go)")
				return true
			}
			tools = append(tools, t)
			return true
		})
	}
	helper, err := parseDir(fset, helperDir)
	if err != nil {
		return nil, err
	}
	consts := map[string]string{}
	for _, f := range helper {
		for _, d := range f.file.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, id := range vs.Names {
					if i < len(vs.Values) {
						if v, ok := stringLit(vs.Values[i]); ok {
							consts[id.Name] = v
						}
					}
				}
			}
		}
	}
	for _, f := range helper {
		ast.Inspect(f.file, func(n ast.Node) bool {
			lit, ok := n.(*ast.CompositeLit)
			if !ok || !isMCPTool(lit.Type) {
				return true
			}
			t := tool{group: "helper", file: f.name, pos: int(lit.Pos())}
			var okName, okDesc bool
			for _, el := range lit.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key, _ := kv.Key.(*ast.Ident)
				switch {
				case key == nil:
				case key.Name == "Name":
					if id, ok := kv.Value.(*ast.Ident); ok {
						t.name, okName = consts[id.Name]
					} else {
						t.name, okName = stringLit(kv.Value)
					}
				case key.Name == "Description":
					t.desc, okDesc = leadingText(kv.Value)
				}
			}
			if !okName || !okDesc {
				problems = append(problems, fset.Position(lit.Pos()).String()+": cannot read the name or description of a tool (update packaging/gen.go)")
				return true
			}
			tools = append(tools, t)
			return true
		})
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "\n"))
	}
	sort.SliceStable(tools, func(i, j int) bool {
		a, b := tools[i], tools[j]
		if groupOrder[a.group] != groupOrder[b.group] {
			return groupOrder[a.group] < groupOrder[b.group]
		}
		if a.file != b.file {
			return a.file < b.file
		}
		return a.pos < b.pos
	})
	seen := map[string]bool{}
	groups := map[string]int{}
	for _, t := range tools {
		if seen[t.name] {
			return nil, fmt.Errorf("tool %s is defined twice", t.name)
		}
		seen[t.name] = true
		groups[t.group]++
	}
	if len(tools) < 10 || len(groups) != len(groupOrder) {
		return nil, fmt.Errorf("found only %d tools in %s and %s (%v): update packaging/gen.go", len(tools), libDir, helperDir, groups)
	}
	return tools, nil
}

type parsedFile struct {
	name string
	file *ast.File
}

// parseDir parses the Go files of dir (not the tests), sorted by name.
func parseDir(fset *token.FileSet, dir string) ([]parsedFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []parsedFile
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		files = append(files, parsedFile{name, f})
	}
	return files, nil
}

// isMCPTool: the type is mcp.Tool.
func isMCPTool(typ ast.Expr) bool {
	sel, ok := typ.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Tool" {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && x.Name == "mcp"
}

// isDef: the called function is def or def[...].
func isDef(fun ast.Expr) bool {
	switch f := fun.(type) {
	case *ast.IndexExpr:
		fun = f.X
	case *ast.IndexListExpr:
		fun = f.X
	}
	id, ok := fun.(*ast.Ident)
	return ok && id.Name == "def"
}

func stringLit(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(lit.Value)
	return s, err == nil
}

// leadingText is the text literal a description starts with ("text" + note).
func leadingText(e ast.Expr) (string, bool) {
	for {
		switch x := e.(type) {
		case *ast.BinaryExpr:
			if x.Op != token.ADD {
				return "", false
			}
			e = x.X
		case *ast.ParenExpr:
			e = x.X
		default:
			return stringLit(e)
		}
	}
}

// ---------------------------------------------------------------------------
// server.json

func serverJSONCmd(args []string) error {
	fs := flag.NewFlagSet("server-json", flag.ContinueOnError)
	version := fs.String("version", "", "release version")
	out := fs.String("out", "", "server.json file to write")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := checkVersion(*version); err != nil {
		return err
	}
	if *out == "" || fs.NArg() == 0 {
		return errors.New("-out and at least one .mcpb file are required")
	}
	if n := len([]rune(registryDescription)); n > 100 {
		return fmt.Errorf("the registry description has %d characters (100 at most)", n)
	}
	type transport struct {
		Type string `json:"type"`
	}
	type pkg struct {
		RegistryType string    `json:"registryType"`
		Identifier   string    `json:"identifier"`
		Version      string    `json:"version"`
		FileSha256   string    `json:"fileSha256"`
		Transport    transport `json:"transport"`
	}
	type repository struct {
		URL       string `json:"url"`
		Source    string `json:"source"`
		Subfolder string `json:"subfolder"`
	}
	type server struct {
		Schema      string     `json:"$schema"`
		Name        string     `json:"name"`
		Title       string     `json:"title"`
		Description string     `json:"description"`
		Repository  repository `json:"repository"`
		WebsiteURL  string     `json:"websiteUrl"`
		Version     string     `json:"version"`
		Packages    []pkg      `json:"packages"`
	}
	s := server{
		Schema:      registrySchema,
		Name:        registryName,
		Title:       registryTitle,
		Description: registryDescription,
		Repository:  repository{URL: repoURL, Source: "github", Subfolder: repoSubfolder},
		WebsiteURL:  repoURL,
		Version:     *version,
	}
	var summary strings.Builder
	for _, path := range fs.Args() {
		name := filepath.Base(path)
		if !strings.HasSuffix(name, ".mcpb") {
			return fmt.Errorf("%s is not a .mcpb file", path)
		}
		sum, size, err := fileSHA256(path)
		if err != nil {
			return err
		}
		s.Packages = append(s.Packages, pkg{
			RegistryType: "mcpb",
			Identifier:   repoURL + "/releases/download/v" + *version + "/" + name,
			Version:      *version,
			FileSha256:   sum,
			Transport:    transport{Type: "stdio"},
		})
		fmt.Fprintf(&summary, "%s  %s  %d bytes\n", sum, name, size)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return err
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Print(summary.String())
	return nil
}

func fileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// ---------------------------------------------------------------------------
// JSON that keeps the order of the keys of the template

type member struct {
	key   string
	value any
}

// object is a JSON object in the order of its keys. The other values are
// string, json.Number, bool, nil and []any.
type object []member

func parseOrdered(data []byte) (object, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("text after the JSON object")
	}
	m, ok := v.(object)
	if !ok {
		return nil, errors.New("not a JSON object")
	}
	return m, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		m := object{}
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := k.(string)
			if slices.ContainsFunc(m, func(x member) bool { return x.key == key }) {
				return nil, fmt.Errorf("key %q appears twice", key)
			}
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			m = append(m, member{key, v})
		}
		_, err = dec.Token()
		return m, err
	case '[':
		list := []any{}
		for dec.More() {
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, v)
		}
		_, err = dec.Token()
		return list, err
	}
	return nil, fmt.Errorf("unexpected %v", d)
}

// set replaces the value at path, which must exist in the template.
func set(m object, path []string, value any) error {
	for i, key := range path {
		j := slices.IndexFunc(m, func(x member) bool { return x.key == key })
		if j < 0 {
			return fmt.Errorf("the template has no %q", strings.Join(path[:i+1], "."))
		}
		if i == len(path)-1 {
			m[j].value = value
			return nil
		}
		next, ok := m[j].value.(object)
		if !ok {
			return fmt.Errorf("%q is not an object in the template", strings.Join(path[:i+1], "."))
		}
		m = next
	}
	return nil
}

func encodeOrdered(m object) []byte {
	var buf bytes.Buffer
	writeValue(&buf, m, "")
	buf.WriteByte('\n')
	return buf.Bytes()
}

func writeValue(buf *bytes.Buffer, v any, indent string) {
	inner := indent + "  "
	switch x := v.(type) {
	case object:
		if len(x) == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteString("{\n")
		for i, mem := range x {
			buf.WriteString(inner)
			writeScalar(buf, mem.key)
			buf.WriteString(": ")
			writeValue(buf, mem.value, inner)
			if i < len(x)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(indent + "}")
	case []any:
		if len(x) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		for i, item := range x {
			buf.WriteString(inner)
			writeValue(buf, item, inner)
			if i < len(x)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(indent + "]")
	default:
		writeScalar(buf, x)
	}
}

func writeScalar(buf *bytes.Buffer, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		fail(err.Error())
	}
	buf.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}
