use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use super::field_catalog;

static OPENAPI_DOCUMENT: OnceLock<Value> = OnceLock::new();

pub fn document_json() -> Result<&'static Value, String> {
    if let Some(document) = OPENAPI_DOCUMENT.get() {
        return Ok(document);
    }
    let document = build_document()?;
    let _ = OPENAPI_DOCUMENT.set(document);
    Ok(OPENAPI_DOCUMENT
        .get()
        .expect("OpenAPI document initialized before return"))
}

fn build_document() -> Result<Value, String> {
    let catalog = field_catalog::catalog_json()?;
    let endpoints = catalog["endpoints"]
        .as_array()
        .ok_or_else(|| "字段库缺少 endpoints".to_string())?;
    let schemas = catalog["schemas"]
        .as_object()
        .ok_or_else(|| "字段库缺少 schemas".to_string())?;
    let known_schemas = schemas.keys().cloned().collect::<HashSet<_>>();

    let mut component_schemas = Map::new();
    for (name, fields) in schemas {
        component_schemas.insert(
            name.clone(),
            object_schema(fields, &known_schemas)
                .map_err(|error| format!("生成 {name} OpenAPI Schema 失败：{error}"))?,
        );
    }
    if !component_schemas.contains_key("ApiError") {
        return Err("字段库缺少 ApiError Schema".to_string());
    }

    let mut paths = Map::new();
    let mut tags = Vec::new();
    let mut seen_tags = HashSet::new();
    for endpoint in endpoints {
        let method = endpoint["method"]
            .as_str()
            .ok_or_else(|| "端点缺少 method".to_string())?
            .to_ascii_lowercase();
        let path = endpoint["path"]
            .as_str()
            .ok_or_else(|| "端点缺少 path".to_string())?;
        let category = endpoint["category"].as_str().unwrap_or("其他");
        if seen_tags.insert(category.to_string()) {
            tags.push(json!({ "name": category }));
        }

        let operation = operation_json(endpoint, path, &method, schemas, &known_schemas)?;
        let path_item = paths
            .entry(path.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let path_item = path_item
            .as_object_mut()
            .ok_or_else(|| format!("无效的 OpenAPI path item：{path}"))?;
        path_item.insert(method, operation);
    }

    Ok(json!({
        "openapi": "3.1.0",
        "info": {
            "title": "HelM AI API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "仅监听本机回环地址的 SSH / SFTP 自动化 REST 网关。"
        },
        "x-helm-field-catalog-version": catalog["version"].clone(),
        "x-helm-selection-rules": catalog["selectionRules"].clone(),
        "x-helm-examples": catalog["examples"].clone(),
        "servers": [{ "url": "/", "description": "当前 HelM AI API 服务" }],
        "tags": tags,
        "security": [{ "bearerAuth": [] }],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "HelM API Key"
                }
            },
            "schemas": component_schemas
        }
    }))
}

fn operation_json(
    endpoint: &Value,
    path: &str,
    method: &str,
    schemas: &Map<String, Value>,
    known_schemas: &HashSet<String>,
) -> Result<Value, String> {
    let category = endpoint["category"].as_str().unwrap_or("其他");
    let summary = endpoint["summary"].as_str().unwrap_or(path);
    let mut operation = Map::new();
    operation.insert("tags".to_string(), json!([category]));
    operation.insert("summary".to_string(), json!(summary));
    operation.insert("operationId".to_string(), json!(operation_id(method, path)));

    let mut parameters = Vec::new();
    if let Some(schema_name) = endpoint["pathSchema"].as_str() {
        parameters.extend(parameter_json(schema_name, "path", schemas, known_schemas)?);
    }
    if let Some(schema_name) = endpoint["querySchema"].as_str() {
        parameters.extend(parameter_json(
            schema_name,
            "query",
            schemas,
            known_schemas,
        )?);
    }
    if let Some(schema_name) = endpoint["headerSchema"].as_str() {
        parameters.extend(parameter_json(
            schema_name,
            "header",
            schemas,
            known_schemas,
        )?);
    }
    if !parameters.is_empty() {
        operation.insert("parameters".to_string(), Value::Array(parameters));
    }

    if let Some(schema_name) = endpoint["bodySchema"].as_str() {
        operation.insert(
            "requestBody".to_string(),
            json!({
                "required": true,
                "content": {
                    "application/json": {
                        "schema": schema_reference(schema_name, known_schemas)
                    }
                }
            }),
        );
    } else if let Some(description) = endpoint["bodyRaw"].as_str() {
        operation.insert(
            "requestBody".to_string(),
            json!({
                "required": true,
                "description": description,
                "content": {
                    "application/octet-stream": {
                        "schema": { "type": "string", "format": "binary" }
                    }
                }
            }),
        );
    }

    operation.insert(
        "responses".to_string(),
        response_json(endpoint, known_schemas),
    );
    Ok(Value::Object(operation))
}

fn response_json(endpoint: &Value, known_schemas: &HashSet<String>) -> Value {
    let response_type = endpoint["responseSchema"].as_str();
    let binary = response_type == Some("binary");
    let content_type = endpoint["responseContentType"]
        .as_str()
        .unwrap_or(if binary {
            "application/octet-stream"
        } else {
            "application/json"
        });
    let response_schema = response_type
        .map(|name| schema_reference(name, known_schemas))
        .unwrap_or_else(|| json!({ "type": "object" }));
    let schema = if content_type == "text/event-stream" {
        json!({
            "type": "string",
            "description": "Server-Sent Events 文本流；事件 data 为 JSON。",
            "x-event-schema": response_schema
        })
    } else {
        response_schema
    };
    let mut success_content = Map::new();
    success_content.insert(content_type.to_string(), json!({ "schema": schema }));
    let mut success = json!({
        "description": "请求成功",
        "content": success_content
    });
    if endpoint["cacheable"].as_bool().unwrap_or(false) {
        success["headers"] = json!({
            "ETag": {
                "description": "当前文档实体标签",
                "schema": { "type": "string" }
            },
            "Cache-Control": {
                "description": "缓存重验证策略",
                "schema": { "type": "string" }
            }
        });
    }
    let error = || {
        json!({
            "description": "请求失败",
            "content": {
                "application/json": {
                    "schema": { "$ref": "#/components/schemas/ApiError" }
                }
            }
        })
    };
    let mut responses = Map::new();
    let success_status = endpoint["successStatus"].as_u64().unwrap_or(200);
    responses.insert(success_status.to_string(), success.clone());
    if endpoint["cacheable"].as_bool().unwrap_or(false) {
        responses.insert(
            "304".to_string(),
            json!({ "description": "文档未变化，响应正文为空" }),
        );
    }
    if binary {
        responses.insert("206".to_string(), success);
    }
    for status in [
        "400", "401", "403", "404", "409", "413", "416", "429", "500", "503",
    ] {
        responses.insert(status.to_string(), error());
    }
    Value::Object(responses)
}

fn parameter_json(
    schema_name: &str,
    location: &str,
    schemas: &Map<String, Value>,
    known_schemas: &HashSet<String>,
) -> Result<Vec<Value>, String> {
    let fields = schemas
        .get(schema_name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("参数结构不存在：{schema_name}"))?;
    fields
        .iter()
        .map(|field| {
            let name = field["name"]
                .as_str()
                .ok_or_else(|| format!("{schema_name} 字段缺少 name"))?;
            let field_type = field["type"].as_str().unwrap_or("string");
            let required = location == "path" || field["required"].as_bool().unwrap_or(false);
            let mut parameter = Map::new();
            parameter.insert("name".to_string(), json!(name));
            parameter.insert("in".to_string(), json!(location));
            parameter.insert("required".to_string(), json!(required));
            let mut schema = type_schema(field_type, known_schemas);
            apply_field_metadata(&mut schema, field);
            parameter.insert("schema".to_string(), schema);
            if let Some(description) = field["description"].as_str() {
                parameter.insert("description".to_string(), json!(description));
            }
            Ok(Value::Object(parameter))
        })
        .collect()
}

fn object_schema(fields: &Value, known_schemas: &HashSet<String>) -> Result<Value, String> {
    let fields = fields
        .as_array()
        .ok_or_else(|| "schema 字段不是数组".to_string())?;
    let mut properties = Map::new();
    let mut required = Vec::new();
    for field in fields {
        let name = field["name"]
            .as_str()
            .ok_or_else(|| "schema 字段缺少 name".to_string())?;
        let field_type = field["type"].as_str().unwrap_or("string");
        let mut schema = type_schema(field_type, known_schemas);
        if let Some(description) = field["description"].as_str() {
            if let Some(object) = schema.as_object_mut() {
                object.insert("description".to_string(), json!(description));
            }
        }
        apply_field_metadata(&mut schema, field);
        properties.insert(name.to_string(), schema);
        if field["required"].as_bool().unwrap_or(false) {
            required.push(json!(name));
        }
    }
    let mut schema = Map::new();
    schema.insert("type".to_string(), json!("object"));
    schema.insert("properties".to_string(), Value::Object(properties));
    if !required.is_empty() {
        schema.insert("required".to_string(), Value::Array(required));
    }
    Ok(Value::Object(schema))
}

fn schema_reference(name: &str, known_schemas: &HashSet<String>) -> Value {
    if let Some(item) = name.strip_suffix("[]") {
        return json!({
            "type": "array",
            "items": type_schema(item, known_schemas)
        });
    }
    if name == "binary" {
        return json!({ "type": "string", "format": "binary" });
    }
    type_schema(name, known_schemas)
}

fn apply_field_metadata(schema: &mut Value, field: &Value) {
    let Some(schema) = schema.as_object_mut() else {
        return;
    };
    for key in ["default", "minimum", "maximum", "example"] {
        if let Some(value) = field.get(key) {
            schema.insert(key.to_string(), value.clone());
        }
    }
}

fn type_schema(field_type: &str, known_schemas: &HashSet<String>) -> Value {
    let field_type = field_type.trim();
    if let Some(item) = field_type.strip_suffix("[]") {
        return json!({
            "type": "array",
            "items": type_schema(item, known_schemas)
        });
    }
    if field_type.starts_with("Record<") {
        return json!({ "type": "object", "additionalProperties": true });
    }
    if field_type.contains('|') {
        let parts = field_type
            .split('|')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let primitive_types = parts
            .iter()
            .map(|part| match *part {
                "string" => Some("string"),
                "number" => Some("number"),
                "boolean" => Some("boolean"),
                "object" => Some("object"),
                "null" => Some("null"),
                _ => None,
            })
            .collect::<Option<Vec<_>>>();
        if let Some(types) = primitive_types {
            return json!({ "type": types });
        }
        if parts
            .iter()
            .any(|part| known_schemas.contains(*part) || *part == "null")
        {
            return json!({
                "anyOf": parts
                    .iter()
                    .map(|part| type_schema(part, known_schemas))
                    .collect::<Vec<_>>()
            });
        }
        return json!({ "type": "string", "enum": parts });
    }
    match field_type {
        "string" => json!({ "type": "string" }),
        "number" => json!({ "type": "number" }),
        "boolean" => json!({ "type": "boolean" }),
        "object" => json!({ "type": "object" }),
        "null" => json!({ "type": "null" }),
        _ if known_schemas.contains(field_type) => {
            json!({ "$ref": format!("#/components/schemas/{field_type}") })
        }
        _ => json!({ "type": "object" }),
    }
}

fn operation_id(method: &str, path: &str) -> String {
    let normalized = path
        .trim_matches('/')
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{method}_{normalized}")
}

#[cfg(test)]
mod tests {
    use super::{document_json, field_catalog};
    use serde_json::json;

    #[test]
    fn openapi_document_matches_field_catalog_operations() {
        let document = document_json().unwrap();
        assert_eq!(document["openapi"], "3.1.0");
        assert_eq!(document["x-helm-field-catalog-version"], 10);
        assert!(document["x-helm-selection-rules"]
            .as_array()
            .is_some_and(|rules| !rules.is_empty()));
        assert_eq!(document["x-helm-examples"]["exec"]["path"], "/api/exec");
        assert_eq!(
            document["components"]["securitySchemes"]["bearerAuth"]["scheme"],
            "bearer"
        );
        let catalog = field_catalog::catalog_json().unwrap();
        let endpoints = catalog["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 31);
        for endpoint in endpoints {
            let path = endpoint["path"].as_str().unwrap();
            let method = endpoint["method"].as_str().unwrap().to_ascii_lowercase();
            assert!(
                document["paths"][path][method].is_object(),
                "missing OpenAPI operation for {} {}",
                endpoint["method"].as_str().unwrap(),
                path
            );
        }
        assert!(document["paths"]["/api/exec"]["post"].is_object());
        assert!(document["paths"]["/openapi.json"]["get"].is_object());
        assert_eq!(
            document["paths"]["/api/upload"]["put"]["requestBody"]["content"]
                ["application/octet-stream"]["schema"]["format"],
            "binary"
        );
        assert!(document["paths"]["/api/jobs"]["post"]["responses"]["202"].is_object());
        assert!(document["paths"]["/api/jobs/{job_id}"]["get"].is_object());
        assert!(
            document["paths"]["/api/jobs/{job_id}/events"]["get"]["responses"]["200"]["content"]
                ["text/event-stream"]
                .is_object()
        );
        assert_eq!(
            document["paths"]["/api/jobs/{job_id}/events"]["get"]["responses"]["200"]["content"]
                ["text/event-stream"]["schema"]["type"],
            "string"
        );
        assert!(
            document["paths"]["/api/jobs/{job_id}/events"]["get"]["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .any(
                    |parameter| parameter["in"] == "header" && parameter["name"] == "Last-Event-ID"
                )
        );
        assert!(document["paths"]["/api/download"]["get"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|parameter| parameter["in"] == "header" && parameter["name"] == "Range"));
    }

    #[test]
    fn openapi_schema_preserves_enums_arrays_and_required_fields() {
        let document = document_json().unwrap();
        let exec = &document["components"]["schemas"]["ExecBody"];
        assert!(exec["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "sessionId"));
        assert_eq!(
            exec["properties"]["safetyMode"]["enum"],
            json!(["balanced", "strict"])
        );
        assert_eq!(exec["properties"]["timeoutMs"]["default"], 30_000);
        assert_eq!(exec["properties"]["timeoutMs"]["minimum"], 1);
        assert_eq!(exec["properties"]["timeoutMs"]["maximum"], 300_000);
        assert_eq!(
            document["components"]["schemas"]["LatencyProbeResult"]["properties"]["samplesMs"]
                ["type"],
            "array"
        );
        assert_eq!(
            document["paths"]["/api/backup/records/{id}"]["delete"]["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .find(|parameter| parameter["name"] == "deleteFile")
                .unwrap()["schema"]["default"],
            false
        );
    }
}
