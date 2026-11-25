import React from "react";
import { createRoot } from "react-dom/client";
import PathFinder from "./PathFinder.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PathFinder />
  </React.StrictMode>
);
