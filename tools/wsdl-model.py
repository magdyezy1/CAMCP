"""Offline structural XSD declaration model for six pinned Microsoft WSDLs.

This is NOT a SOAP-to-JSON transport converter. Ordered XSD particles, restrictions,
inheritance, occurrence constraints and namespace-qualified references are retained
instead of pretending they are equivalent to the provider's JSON representation.
Python's standard library is a development-only generation dependency.
"""
import io
import json
import sys
import xml.etree.ElementTree as ET

WSDL = "{http://schemas.xmlsoap.org/wsdl/}"
XSD = "{http://www.w3.org/2001/XMLSchema}"
SOAP = "{http://schemas.xmlsoap.org/wsdl/soap/}"


def model(xml):
    if len(xml.encode("utf-8")) > 16 * 1024 * 1024:
        raise ValueError("WSDL exceeds 16 MiB")
    if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise ValueError("DTD and entity declarations are forbidden")
    scopes, stack, pending, root = {}, [], {}, None
    for event, node in ET.iterparse(io.StringIO(xml), events=("start-ns", "start", "end")):
        if event == "start-ns":
            pending[node[0]] = node[1]
        elif event == "start":
            scope = {**(stack[-1] if stack else {}), **pending}
            pending = {}
            stack.append(scope)
            scopes[id(node)] = scope
            if root is None:
                root = node
        else:
            stack.pop()
    if root.tag != WSDL + "definitions":
        raise ValueError("Expected WSDL 1.1 definitions")
    if root.findall(WSDL + "import") or root.findall(".//" + XSD + "include") or any(n.get("schemaLocation") for n in root.findall(".//" + XSD + "import")):
        raise ValueError("singleWsdl must not require external WSDL/includes")

    def qname(value, node):
        if ":" in value:
            prefix, local = value.split(":", 1)
            if prefix not in scopes[id(node)]:
                raise ValueError("Unresolved namespace " + prefix)
            return "{" + scopes[id(node)][prefix] + "}" + local
        return "{" + scopes[id(node)].get("", "") + "}" + value

    def tree(node):
        attrs = {k: (qname(v, node) if k in ("type", "base", "ref", "itemType", "element", "message") else
                      [qname(x, node) for x in v.split()] if k == "memberTypes" else v)
                 for k, v in sorted(node.attrib.items())}
        return {"kind": node.tag, "attributes": attrs,
                "children": [tree(child) for child in node if child.tag != XSD + "annotation"]}

    declarations = {}
    for schema in root.findall(".//" + XSD + "schema"):
        ns = schema.get("targetNamespace", "")
        for node in schema:
            name = node.get("name")
            if name:
                # XSD elements and types occupy different symbol spaces.
                key = node.tag.rsplit("}", 1)[-1] + ":{" + ns + "}" + name
                if key in declarations:
                    raise ValueError("Duplicate XSD declaration " + key)
                declarations[key] = tree(node)
    messages = {"{" + root.get("targetNamespace", "") + "}" + n.get("name"): tree(n)
                for n in root.findall(WSDL + "message")}
    methods = {}
    for port in root.findall(WSDL + "portType"):
        for op in port.findall(WSDL + "operation"):
            name = op.get("name")
            if name in methods:
                raise ValueError("Ambiguous WSDL operation " + name)
            methods[name] = {"id": name, "httpMethod": "SOAP", "path": name,
                             "request": tree(op.find(WSDL + "input")),
                             "response": tree(op.find(WSDL + "output"))}
    actions = {}
    for binding in root.findall(WSDL + "binding"):
        for op in binding.findall(WSDL + "operation"):
            soap = op.find(SOAP + "operation")
            if soap is not None:
                actions.setdefault(op.get("name"), set()).add(soap.get("soapAction"))
    for name, operation in methods.items():
        operation["soapActions"] = sorted(actions.get(name, []))
    if not methods or not declarations:
        raise ValueError("WSDL must contain operations and type declarations")
    return {"version": "v13", "namespace": root.get("targetNamespace"), "methods": methods,
            "schemas": declarations, "messages": messages,
            "wire_format": "SOAP/XML; JSON transport equivalence is not asserted"}


if __name__ == "__main__":
    print(json.dumps(model(sys.stdin.read()), ensure_ascii=True, sort_keys=True))
