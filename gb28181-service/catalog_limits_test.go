package gateway

import (
	"strings"
	"testing"
)

func TestCatalogPersistentFieldLimits(t *testing.T) {
	for _, field := range []string{"Name", "Manufacturer", "Model", "ParentID", "Status"} {
		for _, size := range []int{512, 513} {
			body := catalogFixture
			value := strings.Repeat("x", size)
			switch field {
			case "Name":
				body = strings.Replace(body, "<Name>入口</Name>", "<Name>"+value+"</Name>", 1)
			case "Status":
				body = strings.Replace(body, "<Status>ON</Status>", "<Status>"+value+"</Status>", 1)
			default:
				body = strings.Replace(body, "</Item>", "<"+field+">"+value+"</"+field+"></Item>", 1)
			}
			_, err := ParseBusinessMessage([]byte(body), 100)
			if (err != nil) != (size > 512) {
				t.Errorf("field=%s bytes=%d err=%v", field, size, err)
			}
		}
	}
}

func TestCatalogItemScalarsCannotBeOverwritten(t *testing.T) {
	for _, field := range []string{"DeviceID", "Name", "Manufacturer", "Model", "ParentID", "Status"} {
		extra := "<" + field + ">a</" + field + "><" + field + ">b</" + field + ">"
		if field == "DeviceID" {
			extra = "<DeviceID>34020000001320000002</DeviceID>"
		}
		body := strings.Replace(catalogFixture, "</Item>", extra+"</Item>", 1)
		if _, err := ParseBusinessMessage([]byte(body), 100); err == nil {
			t.Errorf("duplicate item field accepted: %s", field)
		}
	}
}
