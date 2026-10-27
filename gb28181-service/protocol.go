package gateway

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const MaxXMLBytes = 256 * 1024

var deviceIDPattern = regexp.MustCompile(`^[0-9]{20}$`)

// Annex J directory nodes include administrative codes as well as devices.
var catalogIDPattern = regexp.MustCompile(`^(?:[0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8}|[0-9]{20})$`)

type Version struct {
	Profile   string `json:"profile"`
	Confirmed bool   `json:"confirmed"`
	Peer      string `json:"peer,omitempty"`
}

// Explicit configuration selects a profile, but is not evidence of negotiation.
func SelectVersion(configured, header string) (Version, error) {
	if configured != "auto" && configured != "2016" && configured != "2022" {
		return Version{}, errors.New("invalid version profile")
	}
	peer := ""
	switch strings.TrimSpace(header) {
	case "2.0":
		peer = "2016"
	case "3.0":
		peer = "2022"
	case "":
	default:
		return Version{}, errors.New("unsupported peer version")
	}
	if configured == "auto" {
		if peer != "" {
			return Version{Profile: peer, Confirmed: true, Peer: peer}, nil
		}
		return Version{Profile: "2016"}, nil
	}
	if peer == "2016" && configured == "2022" {
		return Version{}, errors.New("peer only supports 2016")
	}
	return Version{Profile: configured, Confirmed: peer != "", Peer: peer}, nil
}

type CatalogItem struct {
	Info struct {
		PTZType string `xml:"PTZType" json:"ptzType,omitempty"`
	} `xml:"Info" json:"info"`
	ID           string `xml:"DeviceID" json:"id"`
	Name         string `xml:"Name" json:"name"`
	Manufacturer string `xml:"Manufacturer" json:"manufacturer"`
	Model        string `xml:"Model" json:"model"`
	ParentID     string `xml:"ParentID" json:"parentId"`
	Status       string `xml:"Status" json:"status"`
}
type BusinessMessage struct {
	HasSumNum  bool `xml:"-"`
	PresetList struct {
		Count int         `xml:"Num,attr"`
		Items []PTZPreset `xml:"Item"`
	} `xml:"PresetList"`
	XMLName      xml.Name
	Command      string `xml:"CmdType"`
	SN           string `xml:"SN"`
	DeviceID     string `xml:"DeviceID"`
	Status       string `xml:"Status"`
	Result       string `xml:"Result"`
	DeviceName   string `xml:"DeviceName"`
	Manufacturer string `xml:"Manufacturer"`
	Model        string `xml:"Model"`
	Firmware     string `xml:"Firmware"`
	Online       string `xml:"Online"`
	SumNum       int    `xml:"SumNum"`
	List         struct {
		Count int           `xml:"Num,attr"`
		Items []CatalogItem `xml:"Item"`
	} `xml:"DeviceList"`
}

func xmlDecoder(body []byte) *xml.Decoder {
	d := xml.NewDecoder(bytes.NewReader(body))
	d.CharsetReader = func(charset string, r io.Reader) (io.Reader, error) {
		switch strings.ToLower(charset) {
		case "utf-8", "utf8":
			return r, nil
		case "gb2312", "gbk", "gb18030":
			return transform.NewReader(r, simplifiedchinese.GB18030.NewDecoder()), nil
		default:
			return nil, errors.New("unsupported XML encoding")
		}
	}
	return d
}

// Preflight bounds decoded text and nesting as well as wire bytes. Go's XML
// decoder does not resolve external entities; directives are rejected outright.
func ParseBusinessMessage(body []byte, maxItems int) (BusinessMessage, error) {
	var m BusinessMessage
	if len(body) == 0 || len(body) > MaxXMLBytes || maxItems < 1 {
		return m, errors.New("XML size limit")
	}
	d := xmlDecoder(body)
	depth, roots, textBytes := 0, 0, 0
	presetCountPresent := false
	rootFields := map[string]bool{}
	var itemFields map[string]bool
	for {
		t, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return m, errors.New("malformed XML")
		}
		switch x := t.(type) {
		case xml.Directive:
			return m, errors.New("XML directives forbidden")
		case xml.StartElement:
			if depth == 1 && x.Name.Local == "PresetList" {
				for _, a := range x.Attr {
					if a.Name.Local == "Num" {
						presetCountPresent = true
					}
				}
			}
			if depth == 2 && x.Name.Local == "Item" {
				itemFields = map[string]bool{}
			}
			if depth == 3 && itemFields != nil {
				switch x.Name.Local {
				case "DeviceID", "Name", "Manufacturer", "Model", "ParentID", "Status", "PresetID", "PresetName":
					if itemFields[x.Name.Local] {
						return m, errors.New("duplicate catalog item field")
					}
					itemFields[x.Name.Local] = true
				}
			}
			if depth == 1 {
				// These fields control routing, correlation and directory completion.
				// encoding/xml otherwise silently lets a later scalar overwrite one.
				switch x.Name.Local {
				case "CmdType", "SN", "DeviceID", "Status", "Result", "Online", "SumNum", "DeviceList", "PresetList":
					if rootFields[x.Name.Local] {
						return m, errors.New("duplicate business field")
					}
					rootFields[x.Name.Local] = true
				}
			}
			if depth == 0 {
				roots++
			}
			depth++
			if depth > 16 || roots > 1 || x.Name.Space != "" {
				return m, errors.New("XML structure limit")
			}
		case xml.EndElement:
			if depth == 3 && x.Name.Local == "Item" {
				itemFields = nil
			}
			depth--
		case xml.CharData:
			textBytes += len(x)
			if textBytes > MaxXMLBytes || (depth == 0 && strings.TrimSpace(string(x)) != "") {
				return m, errors.New("XML text limit")
			}
		}
	}
	if roots != 1 || depth != 0 {
		return m, errors.New("invalid XML root")
	}
	if e := xmlDecoder(body).Decode(&m); e != nil {
		return m, errors.New("malformed business XML")
	}
	if !deviceIDPattern.MatchString(m.DeviceID) || len(m.SN) == 0 || len(m.SN) > 20 || strings.TrimLeft(m.SN, "0") == "" {
		return m, errors.New("invalid business identity")
	}
	for _, c := range m.SN {
		if c < '0' || c > '9' {
			return m, errors.New("invalid sequence")
		}
	}
	if m.XMLName.Local != "Notify" && m.XMLName.Local != "Response" {
		return m, errors.New("unsupported business envelope")
	}
	if m.Command == "Catalog" && !rootFields["SumNum"] {
		return m, errors.New("missing catalog total")
	}
	m.HasSumNum = rootFields["SumNum"]
	if m.Command == "PresetQuery" {
		if !rootFields["PresetList"] || !presetCountPresent || m.SumNum < 0 || m.SumNum > 255 || m.PresetList.Count != len(m.PresetList.Items) || len(m.PresetList.Items) > 255 {
			return m, errors.New("invalid preset list")
		}
		return m, nil
	}
	if m.SumNum < 0 || m.SumNum > maxItems || len(m.List.Items) > maxItems || m.List.Count != len(m.List.Items) {
		return m, errors.New("catalog size mismatch")
	}
	seen := map[string]bool{}
	for _, item := range m.List.Items {
		if !catalogIDPattern.MatchString(item.ID) || seen[item.ID] {
			return m, errors.New("invalid catalog item")
		}
		// Every retained metadata string is bounded, not only the display name.
		// Otherwise small batches can accumulate oversized model/manufacturer
		// fields in the long-lived directory despite the wire-size limit.
		for _, field := range []string{item.Name, item.Manufacturer, item.Model, item.ParentID, item.Status} {
			if len(field) > 512 {
				return m, errors.New("catalog field limit")
			}
		}
		seen[item.ID] = true
	}
	return m, nil
}

func QueryXML(command, id string, sn uint32) ([]byte, error) {
	return QueryXMLForProfile(command, id, sn, "2016")
}

func QueryXMLForProfile(command, id string, sn uint32, profile string) ([]byte, error) {
	encoding := "GB2312"
	if profile == "2022" {
		encoding = "GB18030"
	} else if profile != "2016" {
		return nil, errors.New("unsupported query profile")
	}
	// All generated fields are ASCII, whose bytes are identical in both charsets.
	if !deviceIDPattern.MatchString(id) || sn == 0 {
		return nil, errors.New("invalid query identity")
	}
	switch command {
	case "Catalog", "DeviceInfo", "DeviceStatus", "PresetQuery":
	default:
		return nil, errors.New("unsupported query")
	}
	return []byte(fmt.Sprintf("<?xml version=\"1.0\" encoding=\"%s\"?>\r\n<Query><CmdType>%s</CmdType><SN>%d</SN><DeviceID>%s</DeviceID></Query>\r\n", encoding, command, sn, id)), nil
}
