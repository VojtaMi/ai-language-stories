import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ensureLearnerCookie } from "./learnerIdentity";
import { router } from "./router";
import "./index.css";

// Before rendering, so every API request already carries the learner id.
ensureLearnerCookie();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
