import imaplib
import email
from flask import Flask, render_template, request, Response, stream_with_context, jsonify
import json
import logging
import threading
import queue
import time
import socket
from datetime import datetime
import re
import ssl

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# Global dictionary to store active jobs: sync_id -> { 'stop_event': threading.Event(), 'queue': queue.Queue() }
active_jobs = {}

@app.route('/')
def index():
    return render_template('index.html')

def get_ssl_context():
    """Create a non-verifying SSL context."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

def retry_operation(func, retries=3, delay=2):
    """Retries a function call upon exception."""
    last_exception = None
    for i in range(retries):
        try:
            return func()
        except (imaplib.IMAP4.abort, socket.error, ssl.SSLError) as e:
            last_exception = e
            time.sleep(delay)
            # Re-raise if it's the last attempt
    raise last_exception

def worker(q, src_conf, dest_conf, stop_event, log_queue, dry_run=False):
    """
    Worker thread function to process emails from the queue.
    """
    try:
        ssl_ctx = get_ssl_context()
        
        # Create separate connections for each thread
        src_mail = imaplib.IMAP4_SSL(src_conf['host'], int(src_conf['port']), ssl_context=ssl_ctx)
        src_mail.login(src_conf['user'], src_conf['pass'])
        
        dest_mail = None
        if not dry_run:
            dest_mail = imaplib.IMAP4_SSL(dest_conf['host'], int(dest_conf['port']), ssl_context=ssl_ctx)
            dest_mail.login(dest_conf['user'], dest_conf['pass'])

        current_src_folder = None
        current_dest_folder = None

        while not stop_event.is_set():
            try:
                # Get (folder_name, email_id) from queue
                task = q.get(timeout=1)
            except queue.Empty:
                break

            folder, email_id = task

            try:
                if stop_event.is_set():
                    q.task_done()
                    break
                
                # Switch folder if needed
                if folder != current_src_folder:
                    retry_operation(lambda: src_mail.select(folder, readonly=True))
                    current_src_folder = folder
                
                if not dry_run and folder != current_dest_folder:
                    # Try to select, if fails allow create logic 
                    try:
                        dest_mail.select(folder)
                    except:
                        try:
                            # Try create
                            dest_mail.create(folder)
                            dest_mail.select(folder)
                        except:
                            # Fallback to INBOX if folder creation fails or restricted
                            dest_mail.select('INBOX')
                    current_dest_folder = folder

                # Fetch
                res, msg_data = retry_operation(lambda: src_mail.fetch(email_id, '(RFC822)'))
                
                # AGGRESSIVE STOP CHECK
                if stop_event.is_set():
                    q.task_done()
                    break

                if res != 'OK':
                    # Decode safely outside f-string
                    try:
                        eid_str = email_id.decode()
                    except:
                        eid_str = str(email_id)
                        
                    log_queue.put({'message': f'Fail fetch {folder}:{eid_str}', 'is_error': True})
                else:
                    try:
                        eid_str = email_id.decode()
                    except:
                        eid_str = str(email_id)

                    if dry_run:
                        # Just simulate
                        log_queue.put({'message': f'[DRY] Would sync {folder}:{eid_str}', 'increment': 1})
                    else:
                        raw_email = msg_data[0][1]
                        # Append
                        retry_operation(lambda: dest_mail.append(current_dest_folder, None, None, raw_email))
                        log_queue.put({'message': f'Synced {folder}:{eid_str}', 'increment': 1})
            
            except Exception as e:
                try:
                    eid_str = email_id.decode()
                except:
                    eid_str = str(email_id)
                log_queue.put({'message': f'Err {folder}:{eid_str} - {str(e)}', 'is_error': True})
            finally:
                q.task_done()
        
        src_mail.logout()
        if dest_mail:
             dest_mail.logout()
    
    except Exception as e:
        log_queue.put({'message': f'Worker Error: {str(e)}', 'is_error': True})

def sync_process(sync_id, concurrency, src_conf, dest_conf, options):
    """
    Generator function to yield status updates.
    """
    dry_run = options.get('dry_run', False)
    since_date = options.get('since_date', '') # Format: DD-Mon-YYYY
    exclude_folders = options.get('exclude_folders', []) # List of strings

    yield f"data: {json.dumps({'message': 'Starting process...', 'progress': 0})}\n\n"
    
    stop_event = threading.Event()
    job_queue = queue.Queue()
    log_queue = queue.Queue()
    
    # Store queue in active_jobs
    active_jobs[sync_id] = {'stop_event': stop_event, 'queue': job_queue}

    try:
        yield f"data: {json.dumps({'message': 'Connecting to source...'})}\n\n"
        
        # 1. List Folders & IDs
        ssl_ctx = get_ssl_context()
        src_mail = imaplib.IMAP4_SSL(src_conf['host'], int(src_conf['port']), ssl_context=ssl_ctx)
        src_mail.login(src_conf['user'], src_conf['pass'])
        
        # Get list of folders
        status, folders = src_mail.list()
        target_folders = []
        
        if status == 'OK':
            # Regex to parse IMAP list response: flags, delimiter, name
            # Example: (\HasNoChildren) "/" "INBOX"
            list_pattern = re.compile(r'\((?P<flags>.*?)\) "(?P<delimiter>.*?)" (?P<name>.*)')
            for f in folders:
                decoded = f.decode()
                m = list_pattern.search(decoded)
                if m:
                    name = m.group('name')
                    # Strip quoting if present
                    if name.startswith('"') and name.endswith('"'):
                        name = name[1:-1]
                    elif name.startswith("'") and name.endswith("'"):
                        name = name[1:-1]
                        
                    clean_name = name.strip()
                    
                    # Check exclusions
                    if clean_name not in exclude_folders and clean_name.split('/')[-1] not in exclude_folders:
                         target_folders.append(clean_name)
                else:
                    # Fallback parsing
                    parts = decoded_entry.split(' "')
                    if len(parts) > 1:
                        name = parts[-1].rstrip('"')
                        target_folders.append(name)
        else:
            target_folders = ['INBOX'] # Fallback

        total_emails = 0
        
        # 2. Iterate folders and search
        for folder in target_folders:
            if stop_event.is_set(): break
            
            try:
                # Need to quote folder name if it has spaces or special chars
                quoted_folder = f'"{folder}"' if ' ' in folder or '[' in folder else folder
                
                resp, _ = src_mail.select(quoted_folder, readonly=True)
                if resp != 'OK':
                     # Try without quotes if failed? Or try literally
                     resp, _ = src_mail.select(folder, readonly=True)
                
                # STRICT CHECK: If still not OK, skip this folder.
                if resp != 'OK':
                    yield f"data: {json.dumps({'message': f'Skip folder {folder}: Not selectable', 'is_error': True})}\n\n"
                    continue

                search_crit = 'ALL'
                if since_date:
                    search_crit = f'(SINCE "{since_date}")'
                
                typ, messages = src_mail.search(None, search_crit)
                
                if typ == 'OK':
                    ids = messages[0].split()
                    count = len(ids)
                    if count > 0:
                        yield f"data: {json.dumps({'message': f'Folder {folder}: Found {count} emails.'})}\n\n"
                        total_emails += count
                        for eid in ids:
                            job_queue.put((folder, eid))
            except Exception as e:
                 yield f"data: {json.dumps({'message': f'Skip folder {folder}: {str(e)}', 'is_error': True})}\n\n"

        if total_emails == 0:
             yield f"data: {json.dumps({'message': 'No emails found matching criteria.', 'progress': 100})}\n\n"
             return

        yield f"data: {json.dumps({'message': f'Total {total_emails} emails. Starting {concurrency} threads...'})}\n\n"
        
        # 3. Start Workers
        num_threads = min(concurrency, 10) 
        threads = []
        for _ in range(num_threads):
            t = threading.Thread(target=worker, args=(job_queue, src_conf, dest_conf, stop_event, log_queue, dry_run))
            t.daemon = True
            t.start()
            threads.append(t)

        src_mail.logout()

        # 4. Monitor Loop
        processed_count = 0
        
        while any(t.is_alive() for t in threads) or not log_queue.empty():
            if stop_event.is_set():
                 yield f"data: {json.dumps({'message': 'Stopped by user.', 'is_error': True})}\n\n"
                 break

            while not log_queue.empty():
                try:
                    log_item = log_queue.get_nowait()
                    if 'increment' in log_item:
                        processed_count += 1
                        progress = int((processed_count / total_emails) * 100)
                        yield f"data: {json.dumps({'message': log_item['message'], 'progress': progress})}\n\n"
                    else:
                        yield f"data: {json.dumps(log_item)}\n\n"
                except queue.Empty:
                    break
            
            time.sleep(0.1)
        
        if job_queue.empty() and not stop_event.is_set():
            yield f"data: {json.dumps({'message': 'Sync completed!', 'progress': 100})}\n\n"

    except Exception as e:
        yield f"data: {json.dumps({'message': f'Critical Error: {str(e)}', 'is_error': True})}\n\n"
    finally:
        stop_event.set()
        if sync_id in active_jobs:
            del active_jobs[sync_id]

@app.route('/api/stop', methods=['POST'])
def stop_sync():
    data = request.json
    sync_id = data.get('sync_id')
    job = active_jobs.get(sync_id)
    if job:
        job['stop_event'].set()
        # CLEAR QUEUE
        q = job.get('queue')
        if q:
            with q.mutex:
                q.queue.clear()
        logging.info(f"Stop signal received for {sync_id}. Queue cleared.")
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Job not found'}), 404

@app.route('/api/sync', methods=['POST'])
def sync_emails():
    data = request.json
    sync_id = data.get('sync_id')
    concurrency = int(data.get('concurrency', 1))
    
    src_conf = {
        'host': data.get('src_host'),
        'user': data.get('src_user'),
        'pass': data.get('src_pass'),
        'port': data.get('src_port', 993)
    }
    
    dest_conf = {
        'host': data.get('dest_host'),
        'user': data.get('dest_user'),
        'pass': data.get('dest_pass'),
        'port': data.get('dest_port', 993)
    }

    # Advanced options
    options = {
        'dry_run': data.get('dry_run', False),
        'since_date': data.get('since_date', ''),
        'exclude_folders': data.get('exclude_folders', '').split(',') if data.get('exclude_folders') else []
    }
    # Clean excludes
    options['exclude_folders'] = [x.strip() for x in options['exclude_folders'] if x.strip()]

    return Response(stream_with_context(sync_process(
        sync_id, concurrency, src_conf, dest_conf, options
    )), mimetype='text/event-stream')

if __name__ == '__main__':
    app.run(debug=True, port=3000)
