use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use napi::{Error, Result, Status};
use napi_derive::napi;
use parking_lot::{Mutex, RwLock};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::fs;
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Serialize, Deserialize, Debug, Clone)]
enum Operation {
    Set { path: String, value: Value },
    Delete { path: String },
}

#[napi]
pub struct DatabaseCore {
    data: Arc<RwLock<Value>>,
    filename: PathBuf,
    wal_path: PathBuf,
    wal_file: Option<Arc<Mutex<BufWriter<fs::File>>>>,
    encryption_key: Option<Vec<u8>>,
    pretty_print: bool,
    use_wal: bool,
}

#[napi]
impl DatabaseCore {
    #[napi(constructor)]
    pub fn new(
        filename: String,
        encryption_key: Option<String>,
        pretty_print: Option<bool>,
        use_wal: Option<bool>,
    ) -> Result<Self> {
        let path = PathBuf::from(filename);
        let wal_path = path.with_extension("wal");
        let should_use_wal = use_wal.unwrap_or(true);

        let key_bytes = encryption_key
            .map(|k| {
                hex::decode(k)
                    .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid hex key: {}", e)))
            })
            .transpose()?;

        if let Some(ref k) = key_bytes {
            if k.len() != 32 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Encryption key must be 32 bytes".to_string(),
                ));
            }
        }

        let wal_file = if should_use_wal {
            let wal_file_raw = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&wal_path)
                .map_err(|e| {
                    Error::new(Status::GenericFailure, format!("Failed to open WAL: {}", e))
                })?;
            Some(Arc::new(Mutex::new(BufWriter::new(wal_file_raw))))
        } else {
            None
        };

        let db = DatabaseCore {
            data: Arc::new(RwLock::new(Value::Object(serde_json::Map::new()))),
            filename: path,
            wal_path,
            wal_file,
            encryption_key: key_bytes,
            pretty_print: pretty_print.unwrap_or(true),
            use_wal: should_use_wal,
        };

        Ok(db)
    }

    #[napi]
    pub fn load(&self) -> Result<()> {
        // Crash Recovery
        let tmp_path = self.filename.with_extension("tmp");
        if tmp_path.exists() {
            let _ = fs::rename(&tmp_path, &self.filename);
        }

        if !self.filename.exists() {
            let mut data = self.data.write();
            *data = Value::Object(serde_json::Map::new());
        } else {
            let content = fs::read(&self.filename).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to read file: {}", e),
                )
            })?;

            let json_val: Value = if let Some(key) = &self.encryption_key {
                self.decrypt_content(&content, key)?
            } else {
                serde_json::from_slice(&content)
                    .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
            };

            let mut data = self.data.write();
            *data = json_val;
        }

        // Replay WAL
        if self.wal_path.exists() {
            self.replay_wal()?;
        }

        Ok(())
    }

    fn decrypt_content(&self, content: &[u8], key: &[u8]) -> Result<Value> {
        let json_str = String::from_utf8(content.to_vec()).map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "File content is not valid UTF-8".to_string(),
            )
        })?;
        let encrypted_data: Value = serde_json::from_str(&json_str).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Invalid JSON structure for encrypted file: {}", e),
            )
        })?;

        let iv_hex = encrypted_data["iv"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing IV".to_string()))?;
        let content_hex = encrypted_data["content"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing content".to_string()))?;
        let tag_hex = encrypted_data["tag"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing tag".to_string()))?;

        let iv = hex::decode(iv_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid IV hex".to_string()))?;
        let ciphertext = hex::decode(content_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid content hex".to_string()))?;
        let tag = hex::decode(tag_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid tag hex".to_string()))?;

        let mut full_payload = ciphertext;
        full_payload.extend_from_slice(&tag);

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = Nonce::from_slice(&iv);

        let plaintext = cipher
            .decrypt(nonce, full_payload.as_ref())
            .map_err(|_| Error::new(Status::GenericFailure, "Decryption failed".to_string()))?;

        serde_json::from_slice(&plaintext).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Invalid JSON after decryption: {}", e),
            )
        })
    }

    fn replay_wal(&self) -> Result<()> {
        let content = fs::read(&self.wal_path).unwrap_or(vec![]);
        let lines = content.split(|b| *b == b'\n');
        let mut data = self.data.write();

        for line in lines {
            if line.is_empty() {
                continue;
            }

            let op: Operation = if let Some(_key) = &self.encryption_key {
                let json_str = String::from_utf8(line.to_vec()).unwrap_or_default();
                if json_str.trim().is_empty() {
                    continue;
                }
                let encrypted_data: Value = serde_json::from_str(&json_str).unwrap_or(Value::Null);
                if encrypted_data == Value::Null {
                    continue;
                }
                match self.decrypt_value(encrypted_data) {
                    Ok(v) => serde_json::from_value(v)
                        .unwrap_or_else(|_| Operation::Delete { path: "".into() }),
                    Err(_) => continue,
                }
            } else {
                serde_json::from_slice(line)
                    .unwrap_or_else(|_| Operation::Delete { path: "".into() })
            };

            match op {
                Operation::Set { path, value } => {
                    if path.is_empty() {
                        *data = value;
                    } else {
                        set_value_by_path(&mut data, &path, value);
                    }
                }
                Operation::Delete { path } => {
                    if path.is_empty() {
                        *data = Value::Object(serde_json::Map::new());
                    } else {
                        delete_value_by_path(&mut data, &path);
                    }
                }
            }
        }
        Ok(())
    }

    fn decrypt_value(&self, encrypted_data: Value) -> Result<Value> {
        let key = self.encryption_key.as_ref().unwrap();
        let iv_hex = encrypted_data["iv"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing IV".to_string()))?;
        let content_hex = encrypted_data["content"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing content".to_string()))?;
        let tag_hex = encrypted_data["tag"]
            .as_str()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Missing tag".to_string()))?;

        let iv = hex::decode(iv_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid IV hex".to_string()))?;
        let ciphertext = hex::decode(content_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid content hex".to_string()))?;
        let tag = hex::decode(tag_hex)
            .map_err(|_| Error::new(Status::GenericFailure, "Invalid tag hex".to_string()))?;

        let mut full_payload = ciphertext;
        full_payload.extend_from_slice(&tag);

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = Nonce::from_slice(&iv);

        let plaintext = cipher
            .decrypt(nonce, full_payload.as_ref())
            .map_err(|_| Error::new(Status::GenericFailure, "Decryption failed".to_string()))?;

        serde_json::from_slice(&plaintext)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    fn append_wal(&self, op: &Operation) -> Result<()> {
        if let Some(wal_file_arc) = &self.wal_file {
            let mut wal_file = wal_file_arc.lock();

            let output = if let Some(key) = &self.encryption_key {
                let json_string = serde_json::to_string(op).unwrap();
                let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
                let mut iv = [0u8; 12];
                OsRng.fill_bytes(&mut iv);
                let nonce = Nonce::from_slice(&iv);
                let ciphertext_with_tag = cipher
                    .encrypt(nonce, json_string.as_bytes())
                    .map_err(|_| Error::from_status(Status::GenericFailure))?;
                let tag_len = 16;
                let split_idx = ciphertext_with_tag.len() - tag_len;
                let ciphertext = &ciphertext_with_tag[..split_idx];
                let tag = &ciphertext_with_tag[split_idx..];

                let wrapper = serde_json::json!({
                    "iv": hex::encode(iv),
                    "content": hex::encode(ciphertext),
                    "tag": hex::encode(tag)
                });
                serde_json::to_vec(&wrapper)?
            } else {
                serde_json::to_vec(op)?
            };

            wal_file.write_all(&output)?;
            wal_file.write_all(b"\n")?;
            // wal_file.flush()?; // REMOVED FOR PERFORMANCE: BufWriter will flush when needed or on save()
        }
        Ok(())
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        let data = self.data.read();

        let output = if let Some(key) = &self.encryption_key {
            let json_string = serde_json::to_string(&*data).unwrap();
            let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
            let mut iv = [0u8; 12];
            OsRng.fill_bytes(&mut iv);
            let nonce = Nonce::from_slice(&iv);
            let ciphertext_with_tag = cipher
                .encrypt(nonce, json_string.as_bytes())
                .map_err(|_| Error::from_status(Status::GenericFailure))?;
            let tag_len = 16;
            let split_idx = ciphertext_with_tag.len() - tag_len;
            let ciphertext = &ciphertext_with_tag[..split_idx];
            let tag = &ciphertext_with_tag[split_idx..];
            let wrapper = serde_json::json!({
                "iv": hex::encode(iv),
                "content": hex::encode(ciphertext),
                "tag": hex::encode(tag)
            });
            serde_json::to_vec(&wrapper)?
        } else {
            if self.pretty_print {
                serde_json::to_vec_pretty(&*data)?
            } else {
                serde_json::to_vec(&*data)?
            }
        };

        let tmp_path = self.filename.with_extension("tmp");
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(&output)?;
            // Removed sync_all() for performance, rename handles atomicity
        }
        fs::rename(&tmp_path, &self.filename)?;

        // Truncate WAL
        if let Some(wal_file_arc) = &self.wal_file {
            let mut wal_file = wal_file_arc.lock();
            let wal_raw = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.wal_path)
                .map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to truncate WAL: {}", e),
                    )
                })?;
            *wal_file = BufWriter::new(wal_raw);
        }

        Ok(())
    }

    #[napi(js_name = "get")]
    pub fn get_value(&self, path: Option<String>) -> Result<serde_json::Value> {
        let data = self.data.read();
        match path {
            Some(p) => {
                if p.is_empty() {
                    Ok(data.clone())
                } else {
                    let v = get_value_by_path(&data, &p);
                    Ok(v.cloned().unwrap_or(Value::Null))
                }
            }
            None => Ok(data.clone()),
        }
    }

    #[napi]
    pub fn has(&self, path: String) -> Result<bool> {
        if path.is_empty() {
            return Ok(true);
        }
        let data = self.data.read();
        Ok(get_value_by_path(&data, &path).is_some())
    }

    #[napi]
    pub fn set(&self, path: String, value: serde_json::Value) -> Result<()> {
        let op = Operation::Set {
            path: path.clone(),
            value: value.clone(),
        };
        if self.use_wal {
            self.append_wal(&op)?;
        }
        let mut data = self.data.write();
        if path.is_empty() {
            *data = value;
        } else {
            set_value_by_path(&mut data, &path, value);
        }
        Ok(())
    }

    #[napi]
    pub fn delete(&self, path: String) -> Result<()> {
        let op = Operation::Delete { path: path.clone() };
        if self.use_wal {
            self.append_wal(&op)?;
        }
        let mut data = self.data.write();
        if path.is_empty() {
            *data = Value::Object(serde_json::Map::new());
        } else {
            delete_value_by_path(&mut data, &path);
        }
        Ok(())
    }

    #[napi]
    pub fn batch_from_json(&self, ops_json: String) -> Result<()> {
        let ops: Vec<serde_json::Value> = serde_json::from_str(&ops_json)
            .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid JSON: {}", e)))?;
        self.batch(ops)
    }

    #[napi]
    pub fn batch(&self, ops: Vec<serde_json::Value>) -> Result<()> {
        let mut operations = Vec::with_capacity(ops.len());
        for op_val in ops {
            let type_str = op_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let path = op_val
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();

            match type_str {
                "set" => {
                    let val = op_val.get("value").cloned().unwrap_or(Value::Null);
                    operations.push(Operation::Set { path, value: val });
                }
                "delete" => {
                    operations.push(Operation::Delete { path });
                }
                _ => {}
            }
        }

        {
            if self.use_wal {
                if let Some(wal_file_arc) = &self.wal_file {
                    let mut wal_file = wal_file_arc.lock();
                    if let Some(key) = &self.encryption_key {
                        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
                        for op in &operations {
                            let json_string = serde_json::to_string(op).unwrap();
                            let mut iv = [0u8; 12];
                            OsRng.fill_bytes(&mut iv);
                            let nonce = Nonce::from_slice(&iv);
                            let ciphertext_with_tag = cipher
                                .encrypt(nonce, json_string.as_bytes())
                                .map_err(|_| Error::from_status(Status::GenericFailure))?;
                            let tag_len = 16;
                            let split_idx = ciphertext_with_tag.len() - tag_len;
                            let ciphertext = &ciphertext_with_tag[..split_idx];
                            let tag = &ciphertext_with_tag[split_idx..];

                            let wrapper = serde_json::json!({
                                "iv": hex::encode(iv),
                                "content": hex::encode(ciphertext),
                                "tag": hex::encode(tag)
                            });
                            serde_json::to_writer(&mut *wal_file, &wrapper)?;
                            wal_file.write_all(b"\n")?;
                        }
                    } else {
                        for op in &operations {
                            serde_json::to_writer(&mut *wal_file, op)?;
                            wal_file.write_all(b"\n")?;
                        }
                    }
                }
            }
        }

        let mut data = self.data.write();
        for op in operations {
            match op {
                Operation::Set { path, value } => {
                    if path.is_empty() {
                        *data = value;
                    } else {
                        set_value_by_path(&mut data, &path, value);
                    }
                }
                Operation::Delete { path } => {
                    if path.is_empty() {
                        *data = Value::Object(serde_json::Map::new());
                    } else {
                        delete_value_by_path(&mut data, &path);
                    }
                }
            }
        }
        Ok(())
    }

    #[napi]
    pub fn find(
        &self,
        path: String,
        query: serde_json::Value,
        options: Option<QueryOptions>,
    ) -> Result<Vec<serde_json::Value>> {
        let data = self.data.read();
        let collection = get_value_by_path(&data, &path);

        let items_ref: Vec<&Value> = match collection {
            Some(Value::Array(arr)) => arr.iter().collect(),
            Some(Value::Object(map)) => map.values().collect(),
            _ => return Ok(Vec::new()),
        };

        let mut results: Vec<&Value> = items_ref
            .into_iter()
            .filter(|item| matches_query(item, &query))
            .collect();

        // 1. Sort
        if let Some(opts) = &options {
            if let Some(sort_opts) = &opts.sort {
                results.sort_by(|a, b| sort_json(a, b, sort_opts));
            }
        }

        // 2. Skip
        let skip = options
            .as_ref()
            .map(|o| o.skip.unwrap_or(0) as usize)
            .unwrap_or(0);
        let iter = results.into_iter().skip(skip);

        // 3. Limit
        let limit = options
            .as_ref()
            .map(|o| o.limit.unwrap_or(u32::MAX) as usize)
            .unwrap_or(usize::MAX);
        let limited_results: Vec<&Value> = iter.take(limit).collect();

        // 4. Project (Select)
        let selected_results: Vec<Value> = limited_results
            .into_iter()
            .map(|item| {
                if let Some(opts) = &options {
                    if let Some(fields) = &opts.select {
                        if fields.is_empty() {
                            return item.clone();
                        }
                        let mut map = serde_json::Map::new();
                        for field in fields {
                            if let Some(val) = get_value_by_path(item, field) {
                                set_value_by_path(
                                    &mut Value::Object(map.clone()),
                                    field,
                                    val.clone(),
                                );
                            }
                        }
                        return Value::Object(map);
                    }
                }
                item.clone()
            })
            .collect();

        Ok(selected_results)
    }

    #[napi]
    pub fn find_one(
        &self,
        path: String,
        query: serde_json::Value,
    ) -> Result<Option<serde_json::Value>> {
        let data = self.data.read();
        let collection = get_value_by_path(&data, &path);

        match collection {
            Some(Value::Array(arr)) => {
                for item in arr {
                    if matches_query(item, &query) {
                        return Ok(Some(item.clone()));
                    }
                }
                Ok(None)
            }
            Some(Value::Object(map)) => {
                for item in map.values() {
                    if matches_query(item, &query) {
                        return Ok(Some(item.clone()));
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
}

#[napi(object)]
pub struct QueryOptions {
    pub limit: Option<u32>,
    pub skip: Option<u32>,
    pub sort: Option<serde_json::Value>,
    pub select: Option<Vec<String>>,
}

// Helpers

fn sort_json(a: &Value, b: &Value, sort_opts: &Value) -> Ordering {
    if let Value::Object(map) = sort_opts {
        for (key, order_val) in map {
            let val_a = get_value_by_path(a, key);
            let val_b = get_value_by_path(b, key);

            let order = order_val.as_i64().unwrap_or(1);

            let cmp = match (val_a, val_b) {
                (Some(va), Some(vb)) => compare_json(va, vb)
                    .map(|i| {
                        if i == 0 {
                            Ordering::Equal
                        } else if i < 0 {
                            Ordering::Less
                        } else {
                            Ordering::Greater
                        }
                    })
                    .unwrap_or(Ordering::Equal),
                (Some(_), None) => Ordering::Greater,
                (None, Some(_)) => Ordering::Less,
                (None, None) => Ordering::Equal,
            };

            if cmp != Ordering::Equal {
                return if order < 0 { cmp.reverse() } else { cmp };
            }
        }
    }
    Ordering::Equal
}

fn get_value_by_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(root);
    }
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = root;
    for part in parts {
        match current {
            Value::Object(map) => {
                current = map.get(part)?;
            }
            Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    current = arr.get(idx)?;
                } else {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(current)
}

fn set_value_by_path(root: &mut Value, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() {
        return;
    }

    let mut current = root;
    for (i, part) in parts.iter().enumerate() {
        let is_last = i == parts.len() - 1;

        // 1. Handle Array/Object auto-creation if current is not a container
        if !current.is_object() && !current.is_array() {
            // Determine next container type based on the *next* part (if available)
            // or if it's the last part, we just need a container for *this* key.
            // But if we are overwriting a scalar, 'current' is effectively the parent of the thing we are setting?
            // Wait, no. 'current' IS the container we are traversing INTO.
            // If i=0, part="user", current=root. root is Object.
            // If user doesn't exist, we insert "user".
            // The logic below handles *replacing* a scalar current with a container.

            let next_part_is_index = if !is_last {
                parts[i + 1].parse::<usize>().is_ok()
            } else {
                // If we are at the last part, e.g. set("a.b", val).
                // Processing "b". If "b" is numeric, we might want "a" to be array.
                // But we are ALREADY at "a". 'current' is "a".
                // If "a" is scalar, we must replace it.
                // If "b" is "1", "a" should become Array?
                // Lodash says yes.
                part.parse::<usize>().is_ok()
            };

            *current = if next_part_is_index {
                Value::Array(Vec::new())
            } else {
                Value::Object(serde_json::Map::new())
            };
        }

        // 2. Perform the Set (if last) or Ensure Child Exists (if not last)
        match current {
            Value::Object(map) => {
                if is_last {
                    map.insert(part.to_string(), value);
                    return;
                } else {
                    if !map.contains_key(*part) {
                        // Decide child type
                        let next_is_array = parts[i + 1].parse::<usize>().is_ok();
                        let new_child = if next_is_array {
                            Value::Array(Vec::new())
                        } else {
                            Value::Object(serde_json::Map::new())
                        };
                        map.insert(part.to_string(), new_child);
                    }
                    // Traverse
                    current = map.get_mut(*part).unwrap();
                }
            }
            Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    // Expand array if needed
                    while arr.len() <= idx {
                        arr.push(Value::Null);
                    }

                    if is_last {
                        arr[idx] = value;
                        return;
                    } else {
                        // Ensure child exists (if it was Null from padding, replace it)
                        if arr[idx].is_null() {
                            let next_is_array = parts[i + 1].parse::<usize>().is_ok();
                            let new_child = if next_is_array {
                                Value::Array(Vec::new())
                            } else {
                                Value::Object(serde_json::Map::new())
                            };
                            arr[idx] = new_child;
                        }
                        // Traverse
                        current = arr.get_mut(idx).unwrap();
                    }
                } else {
                    // Non-numeric index on Array -> Do nothing (or convert to Object?)
                    // Lodash would technically treat the array as an object and add the property "foo".
                    // But serde_json::Value::Array is strictly a list. We can't turn it into an Object without losing array semantics or data?
                    // For now, we return, keeping existing behavior for invalid array access.
                    return;
                }
            }
            _ => return,
        }
    }
}

fn delete_value_by_path(root: &mut Value, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() {
        return;
    }

    let mut current = root;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            match current {
                Value::Object(map) => {
                    map.remove(*part);
                }
                Value::Array(arr) => {
                    if let Ok(idx) = part.parse::<usize>() {
                        if idx < arr.len() {
                            arr.remove(idx);
                        }
                    }
                }
                _ => {}
            }
            return;
        }

        match current {
            Value::Object(map) => {
                if let Some(next) = map.get_mut(*part) {
                    current = next;
                } else {
                    return;
                }
            }
            Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    if let Some(next) = arr.get_mut(idx) {
                        current = next;
                    } else {
                        return;
                    }
                } else {
                    return;
                }
            }
            _ => return,
        }
    }
}

fn matches_query(item: &Value, query: &Value) -> bool {
    if let Value::Object(query_map) = query {
        for (key, condition) in query_map {
            let item_val = get_value_by_path(item, key);
            if !check_condition(item_val, condition) {
                return false;
            }
        }
        true
    } else {
        false
    }
}

fn check_condition(value: Option<&Value>, condition: &Value) -> bool {
    if let Value::Object(op_map) = condition {
        let has_ops = op_map.keys().any(|k| k.starts_with('$'));
        if !has_ops {
            return Some(condition) == value;
        }

        for (op, op_val) in op_map {
            if !match_operator(value, op, op_val) {
                return false;
            }
        }
        true
    } else {
        match value {
            Some(v) => v == condition,
            None => condition.is_null(),
        }
    }
}

fn match_operator(value: Option<&Value>, op: &str, target: &Value) -> bool {
    let v = match value {
        Some(val) => val,
        None => return op == "$exists" && target == &Value::Bool(false),
    };

    match op {
        "$eq" => v == target,
        "$ne" => v != target,
        "$gt" => compare_json(v, target).map(|c| c > 0).unwrap_or(false),
        "$gte" => compare_json(v, target).map(|c| c >= 0).unwrap_or(false),
        "$lt" => compare_json(v, target).map(|c| c < 0).unwrap_or(false),
        "$lte" => compare_json(v, target).map(|c| c <= 0).unwrap_or(false),
        "$in" => {
            if let Value::Array(arr) = target {
                arr.contains(v)
            } else {
                false
            }
        }
        "$nin" => {
            if let Value::Array(arr) = target {
                !arr.contains(v)
            } else {
                false
            }
        }
        "$exists" => {
            if let Value::Bool(should_exist) = target {
                *should_exist
            } else {
                false
            }
        }
        _ => false,
    }
}

fn compare_json(a: &Value, b: &Value) -> Option<i32> {
    match (a, b) {
        (Value::Number(n1), Value::Number(n2)) => {
            if n1.is_f64() || n2.is_f64() {
                n1.as_f64()?.partial_cmp(&n2.as_f64()?).map(ord_to_int)
            } else {
                n1.as_i64()?.partial_cmp(&n2.as_i64()?).map(ord_to_int)
            }
        }
        (Value::String(s1), Value::String(s2)) => Some(ord_to_int(s1.cmp(s2))),
        _ => None,
    }
}

fn ord_to_int(o: Ordering) -> i32 {
    match o {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}
