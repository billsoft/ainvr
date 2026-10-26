package onvif

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

const deviceNS = "http://www.onvif.org/ver10/device/wsdl"
const media1NS = "http://www.onvif.org/ver10/media/wsdl"
const media2NS = "http://www.onvif.org/ver20/media/wsdl"
const schemaNS = "http://www.onvif.org/ver10/schema"
const soapNS = "http://www.w3.org/2003/05/soap-envelope"

type node struct {
	Namespaces map[string]string
	Name       xml.Name
	Attrs      []xml.Attr
	Text       string
	Children   []*node
}

// Go's XML decoder does not fetch entities. Reject directives as well, and
// independently bound depth, tokens and text before interpreting device data.
func parseXML(data []byte) (*node, error) {
	if len(data) > 2<<20 {
		return nil, failure("response_too_large")
	}
	d := xml.NewDecoder(bytes.NewReader(data))
	var root *node
	stack := []*node{}
	tokens := 0
	for {
		t, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, failure("invalid_xml")
		}
		tokens++
		if tokens > 40000 {
			return nil, failure("xml_limit")
		}
		switch v := t.(type) {
		case xml.Directive:
			return nil, failure("xml_directive_forbidden")
		case xml.StartElement:
			if len(stack) >= 32 {
				return nil, failure("xml_limit")
			}
			n := &node{Name: v.Name, Attrs: v.Attr, Namespaces: map[string]string{}}
			if len(stack) > 0 {
				for key, value := range stack[len(stack)-1].Namespaces {
					n.Namespaces[key] = value
				}
			}
			for _, attr := range v.Attr {
				if attr.Name.Space == "xmlns" {
					n.Namespaces[attr.Name.Local] = attr.Value
				}
				if attr.Name.Space == "" && attr.Name.Local == "xmlns" {
					n.Namespaces[""] = attr.Value
				}
			}
			if len(stack) > 0 {
				p := stack[len(stack)-1]
				p.Children = append(p.Children, n)
			} else {
				if root != nil {
					return nil, failure("invalid_xml")
				}
				root = n
			}
			stack = append(stack, n)
		case xml.CharData:
			if len(stack) > 0 {
				n := stack[len(stack)-1]
				if len(n.Text)+len(v) > 65536 {
					return nil, failure("xml_limit")
				}
				n.Text += string(v)
			}
		case xml.EndElement:
			if len(stack) == 0 {
				return nil, failure("invalid_xml")
			}
			stack = stack[:len(stack)-1]
		}
	}
	if root == nil || len(stack) != 0 {
		return nil, failure("invalid_xml")
	}
	return root, nil
}
func (n *node) child(name string) *node {
	if n != nil {
		for _, c := range n.Children {
			if c.Name.Local == name && (c.Name.Space == schemaNS || c.Name.Space == deviceNS || c.Name.Space == media1NS || c.Name.Space == media2NS || c.Name.Space == soapNS) {
				return c
			}
		}
	}
	return nil
}
func (n *node) text(name string) string {
	c := n.child(name)
	if c == nil {
		return ""
	}
	return strings.TrimSpace(c.Text)
}
func (n *node) attr(name string) string {
	if n != nil {
		for _, a := range n.Attrs {
			if a.Name.Local == name && a.Name.Space == "" {
				return a.Value
			}
		}
	}
	return ""
}
func (n *node) path(names ...string) *node {
	for _, name := range names {
		n = n.child(name)
	}
	return n
}
func escape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// Fault decisions use QName values, never arbitrary Reason/Detail text.
func faultCode(n *node) string {
	if n == nil {
		return "device_fault"
	}
	for _, child := range n.Children {
		if child.Name.Space != soapNS {
			continue
		}
		if child.Name.Local == "Value" {
			text := strings.TrimSpace(child.Text)
			prefix, local, ok := strings.Cut(text, ":")
			if !ok {
				local = prefix
				prefix = ""
			}
			ns := child.Namespaces[prefix]
			if ns == "http://www.onvif.org/ver10/error" {
				if local == "NotAuthorized" {
					return "authentication_failed"
				}
				if local == "ActionNotSupported" || local == "OptionalActionNotImplemented" {
					return "operation_unsupported"
				}
			}
			if ns == "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" && local == "FailedAuthentication" {
				return "authentication_failed"
			}
		}
		if child.Name.Local == "Code" || child.Name.Local == "Subcode" {
			if code := faultCode(child); code != "device_fault" {
				return code
			}
		}
	}
	return "device_fault"
}
