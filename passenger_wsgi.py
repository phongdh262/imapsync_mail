import sys, os

# Add the project directory to sys.path
sys.path.append(os.getcwd())

# Import the Flask app
# 'app' here corresponds to the filename 'app.py'
# 'application' is what Passenger looks for by default
from app import app as application
